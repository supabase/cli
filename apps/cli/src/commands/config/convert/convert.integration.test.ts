import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { parseJsonc } from "@supabase/config/internal";
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { configConvert } from "./convert.handler.ts";
import {
  DRY_RUN_MIN_VERSION_WARNING,
  CONFIG_JSONC_MIN_CLI_VERSION,
  JSONC_APPEARED_MESSAGE,
  JSONC_CHANGED_NOTE,
  JSONC_VANISHED_MESSAGE,
  MIN_VERSION_WARNING,
  JSONC_REMOVED_NOTE,
  jsonAppearedMessage,
  NOT_UTF8_MESSAGE,
} from "./convert.format.ts";

const tempRoot = useTempWorkdir("supabase-config-convert-");

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly explicitWorkdir?: boolean;
  readonly outputFlag?: "json";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    mockCommandSettings({
      workdir: tempRoot.current,
      explicitWorkdir: opts.explicitWorkdir ?? false,
    }),
    Layer.succeed(
      OutputFlag,
      opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    ),
    BunServices.layer,
  );
  return { layer, out, telemetry };
}

const projectPath = (...segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(tempRoot.current, ...segments);
  });

const writeFile = Effect.fnUntraced(function* (segments: ReadonlyArray<string>, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* projectPath(...segments);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, text);
});

const readFile = Effect.fnUntraced(function* (...segments: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* projectPath(...segments));
});

const exists = Effect.fnUntraced(function* (...segments: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(yield* projectPath(...segments));
});

const materializedConfig = Effect.fnUntraced(
  function* () {
    const values = yield* CliConfigValues;
    const resolved = yield* values.load({ workdir: tempRoot.current, projectRef: Option.none() });
    return resolved.materialized.config;
  },
  Effect.provide(Layer.mergeAll(configValuesLayer(), BunServices.layer)),
);

const run = (dryRun = false) => configConvert({ dryRun });

const configTomlPath = projectPath("supabase", "config.toml");

const denied = (method: string, pathOrDescriptor: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor,
  });

type FsFailure =
  | "reread"
  | "remove"
  | "reread-and-jsonc-stuck"
  | "jsonc-appears"
  | "both-edited"
  | "jsonc-removed"
  | "json-appears";

const failingConfigTomlFsLayer = (failure: FsFailure) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const target = yield* configTomlPath;
      const jsonc = yield* projectPath("supabase", "config.jsonc");
      const json = yield* projectPath("supabase", "config.json");
      const rereadFails = failure === "reread" || failure === "reread-and-jsonc-stuck";
      return FileSystem.FileSystem.of({
        ...real,
        stat: (path) =>
          failure === "jsonc-appears" && path === target
            ? real.writeFileString(jsonc, "{}\n").pipe(Effect.andThen(real.stat(path)))
            : real.stat(path),
        readFileString: (path, encoding) =>
          failure === "json-appears" && path === target
            ? real
                .exists(jsonc)
                .pipe(
                  Effect.flatMap((written) =>
                    written
                      ? real
                          .writeFileString(json, "{}\n")
                          .pipe(Effect.andThen(real.readFileString(path, encoding)))
                      : real.readFileString(path, encoding),
                  ),
                )
            : failure === "jsonc-removed" && path === target
              ? real
                  .exists(jsonc)
                  .pipe(
                    Effect.flatMap((written) =>
                      written
                        ? real
                            .remove(jsonc)
                            .pipe(Effect.andThen(real.readFileString(path, encoding)))
                        : real.readFileString(path, encoding),
                    ),
                  )
              : failure === "both-edited" && path === target
                ? real
                    .exists(jsonc)
                    .pipe(
                      Effect.flatMap((written) =>
                        written
                          ? real
                              .writeFileString(jsonc, '{ "edited": true }\n')
                              .pipe(Effect.as('project_id = "edited"\n'))
                          : real.readFileString(path, encoding),
                      ),
                    )
                : rereadFails && path === target
                  ? real
                      .exists(jsonc)
                      .pipe(
                        Effect.flatMap((written) =>
                          written
                            ? Effect.fail(denied("readFileString", path))
                            : real.readFileString(path, encoding),
                        ),
                      )
                  : real.readFileString(path, encoding),
        remove: (path, options) =>
          (failure === "remove" && path === target) ||
          (failure === "reread-and-jsonc-stuck" && path === jsonc)
            ? Effect.fail(denied("remove", path))
            : real.remove(path, options),
      });
    }),
  );

const SIMPLE_TOML = `#:schema https://supabase.com/schemas/config/v1.json
# project name
project_id = "demo"

[api]
port = 54321 # default
`;

describe("config convert integration", () => {
  it.effect(
    "converts the init template, keeping every prose comment once and the same config",
    () => {
      const { layer, out, telemetry } = setup();
      const template = renderCliConfigTemplate("demo", false);
      const tomlExample = /^#\s?(\[[^\]]+\]|[\w."'-]+ = .+)$/;
      const templateComments = template
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("#") && !line.startsWith("#:schema"));
      const expectedProse = templateComments
        .filter((line) => !tomlExample.test(line))
        .map((line) => `//${line.slice(1)}`.trimEnd());
      return Effect.gen(function* () {
        yield* writeFile(["supabase", "config.toml"], template);
        const before = yield* materializedConfig();

        yield* run().pipe(Effect.provide(layer));

        expect(yield* exists("supabase", "config.toml")).toBe(false);
        const jsonc = yield* readFile("supabase", "config.jsonc");
        const actualComments = jsonc
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("//"))
          .map((line) => {
            const inner = line.replace(/^\/\/ +/, "");
            return inner.startsWith("//") ? inner : line;
          });
        const prose = new Set(expectedProse);
        expect(actualComments.filter((line) => prose.has(line)).sort()).toEqual(
          [...expectedProse].sort(),
        );
        expect(actualComments.filter((line) => /^\/\/ \[.*\]$/.test(line))).toEqual([]);
        expect(yield* materializedConfig()).toEqual(before);

        expect(out.stdoutText.split("\n")).toEqual([
          "✓ Converted supabase/config.toml to supabase/config.jsonc",
          "",
          "  Changes",
          "    + Created  supabase/config.jsonc",
          "    - Deleted  supabase/config.toml",
          "",
          "  ⚠ Compatibility",
          "    Supabase CLI versions before 3.1.0 ignore config.jsonc and run with defaults.",
          "    Upgrade the Supabase CLI on every machine and CI job that uses this project.",
          "",
          "  To undo:",
          "    git restore supabase/config.toml && rm supabase/config.jsonc",
          "",
        ]);
        expect(out.stderrText).toBe("");
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("writes the schema directive as $schema and keeps comments in place", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      yield* run().pipe(Effect.provide(layer));

      const jsonc = yield* readFile("supabase", "config.jsonc");
      expect(parseJsonc(jsonc)).toEqual({
        $schema: "https://supabase.com/schemas/config/v1.json",
        project_id: "demo",
        api: { port: 54321 },
      });
      expect(jsonc).toContain("// project name");
      expect(jsonc).toContain('"port": 54321 // default');
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("gives config.jsonc the permissions of the config.toml it replaces", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
      yield* fs.chmod(yield* configTomlPath, 0o600);

      yield* run().pipe(Effect.provide(layer));

      const info = yield* fs.stat(yield* projectPath("supabase", "config.jsonc"));
      expect(info.mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps a comment inside a multi-line array in place without a warning", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(
        ["supabase", "config.toml"],
        '[api]\nschemas = [\n  "public", # keep\n  "graphql",\n]\n',
      );

      yield* run().pipe(Effect.provide(layer));

      expect(yield* readFile("supabase", "config.jsonc")).toContain('"public", // keep');
      expect(out.stdoutText).not.toContain("relocated");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("reports comments moved out of values it cannot place", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(
        ["supabase", "config.toml"],
        "[api]\nschemas = [\n  [1], # keep\n  [2],\n]\n",
      );

      yield* run().pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain(
        "  ℹ 1 comment relocated\n    Comments inside nested arrays or inline tables move to the line above their key.\n    line 3 → api.schemas  # keep\n",
      );
      expect(yield* readFile("supabase", "config.jsonc")).toContain("// keep");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("fails with the init hint when no config exists", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);
      expect(error._tag).toBe("ConfigConvertLoadConfigError");
      expect(error.message).toBe(
        "failed to read supabase/config.toml, config.json or config.jsonc: file not found. Run `supabase init` to create one.",
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("names the workdir when an explicit --workdir has no project", () => {
    const { layer } = setup({ explicitWorkdir: true });
    return Effect.gen(function* () {
      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);
      expect(error._tag).toBe("ConfigConvertLoadConfigError");
      expect(error.message).toContain(tempRoot.current);
      expect(error.message).toContain("--workdir/SUPABASE_WORKDIR is used exactly as given");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("reports a TOML parse failure against config.toml", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], "[api\nport = 1\n");
      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);
      expect(error._tag).toBe("ConfigConvertLoadConfigError");
      expect(error.message).toContain("failed to parse supabase/config.toml");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect.each(["config.jsonc", "config.json"] as const)(
    "refuses when config.toml and %s both exist and leaves both files untouched",
    (existing) => {
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
        yield* writeFile(["supabase", existing], "{}\n");

        const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

        expect(error._tag).toBe("ConfigConvertAlreadyJsonError");
        expect(error.message).toBe(
          `supabase/config.toml is ignored because supabase/${existing} takes precedence. Delete supabase/${existing} first to convert config.toml again.`,
        );
        expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
        expect(yield* readFile("supabase", existing)).toBe("{}\n");
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.each(["config.jsonc", "config.json"] as const)(
    "succeeds without changes when only %s exists",
    (existing) => {
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* writeFile(["supabase", existing], "{}\n");

        yield* run().pipe(Effect.provide(layer));

        expect(out.stdoutText).toBe(
          `supabase/${existing} is already the project config; nothing to convert.\n`,
        );
        expect(out.stderrText).toBe("");
        expect(yield* readFile("supabase", existing)).toBe("{}\n");
        expect(yield* exists("supabase", "config.toml")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("reports nothing converted in json mode when config.jsonc already exists", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], "{}\n");

      yield* run().pipe(Effect.provide(layer));

      expect(out.messages).toEqual([
        {
          type: "success",
          message: "supabase/config.jsonc is already the project config; nothing to convert.",
          data: { converted: false, path: "supabase/config.jsonc" },
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("refuses a config.toml that is not valid UTF-8, leaving it byte-identical", () => {
    const { layer } = setup();
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('project_id = "caf'),
      0xe9,
      ...new TextEncoder().encode('"\n'),
    ]);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* writeFile(["supabase", "config.toml"], "");
      const tomlPath = yield* projectPath("supabase", "config.toml");
      yield* fs.writeFile(tomlPath, bytes);

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertUnsupportedError");
      expect(error.message).toBe(NOT_UTF8_MESSAGE);
      expect([...(yield* fs.readFile(tomlPath))]).toEqual([...bytes]);
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("refuses a TOML date, leaving config.toml byte-identical and writing nothing", () => {
    const { layer } = setup();
    const toml = '# keep me\nproject_id = "demo"\nwhen = 1979-05-27\n';
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], toml);

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertUnsupportedError");
      expect(error.message).toContain("at line 3");
      expect(error.message).toContain("Quote the value as a string, then rerun.");
      expect(yield* readFile("supabase", "config.toml")).toBe(toml);
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("adds the schema domain to an existing commented VS Code settings file", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
      yield* writeFile([".vscode", "settings.json"], '{\n  // mine\n  "editor.fontSize": 14\n}\n');

      yield* run().pipe(Effect.provide(layer));

      const settings = yield* readFile(".vscode", "settings.json");
      expect(settings).toContain("// mine");
      expect(parseJsonc(settings)).toEqual({
        "editor.fontSize": 14,
        "json.schemaDownload.trustedDomains": { "https://supabase.com/schemas/": true },
      });
      expect(out.stdoutText).toContain(
        "    ~ Updated  .vscode/settings.json (trusts https://supabase.com/schemas/)\n",
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("does not create .vscode when it does not exist", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      yield* run().pipe(Effect.provide(layer));

      expect(yield* exists(".vscode")).toBe(false);
      expect(out.stdoutText).not.toContain(".vscode/settings.json");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("warns but still converts when settings.json is malformed", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
      yield* writeFile([".vscode", "settings.json"], "{ nope");

      yield* run().pipe(Effect.provide(layer));

      expect(yield* exists("supabase", "config.jsonc")).toBe(true);
      expect(yield* exists("supabase", "config.toml")).toBe(false);
      expect(yield* readFile(".vscode", "settings.json")).toBe("{ nope");
      expect(out.stdoutText).toContain("  ⚠ Could not update .vscode/settings.json\n");
      expect(out.stdoutText).toContain(
        'Add "https://supabase.com/schemas/": true under "json.schemaDownload.trustedDomains" to trust the config schema.',
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("--dry-run prints the JSONC and writes nothing", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
      yield* writeFile([".vscode", "settings.json"], "{}\n");

      yield* run(true).pipe(Effect.provide(layer));

      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
      expect(yield* readFile(".vscode", "settings.json")).toBe("{}\n");
      expect(parseJsonc(out.stdoutText)).toMatchObject({
        project_id: "demo",
        api: { port: 54321 },
      });
      expect(out.stderrText).toContain(
        [
          "✓ Config conversion preview",
          "  Dry run. No files were changed.",
          "",
          "  Planned changes",
          "    + Create  supabase/config.jsonc",
          "    - Delete  supabase/config.toml",
          "    ~ Update  .vscode/settings.json (trusts https://supabase.com/schemas/)",
        ].join("\n"),
      );
      expect(out.stderrText).toContain("  To undo after converting:\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("--dry-run lists no VS Code change when settings need none", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      yield* run(true).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("    - Delete  supabase/config.toml\n\n");
      expect(out.stderrText).not.toContain(".vscode/settings.json");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("emits a structured payload in json mode without stderr noise", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      yield* run().pipe(Effect.provide(layer));

      expect(out.stderrText).toBe("");
      expect(out.stdoutText).toBe("");
      expect(out.messages).toEqual([
        {
          type: "success",
          message: "Converted supabase/config.toml to supabase/config.jsonc.",
          data: expect.objectContaining({
            path: "supabase/config.jsonc",
            converted: true,
            removed: "supabase/config.toml",
            schema: "https://supabase.com/schemas/config/v1.json",
            moved_comments: [],
            vscode_settings_updated: false,
            min_cli_version: CONFIG_JSONC_MIN_CLI_VERSION,
            warnings: expect.arrayContaining([MIN_VERSION_WARNING]),
          }),
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("--dry-run in json mode carries the document and writes nothing", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      yield* run(true).pipe(Effect.provide(layer));

      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
      const [message] = out.messages;
      expect(message).toMatchObject({
        type: "success",
        data: {
          dry_run: true,
          would_remove: "supabase/config.toml",
          would_update_vscode_settings: false,
          content: expect.stringContaining('"project_id": "demo"'),
          warnings: expect.arrayContaining([DRY_RUN_MIN_VERSION_WARNING]),
        },
      });
      expect(message?.data).not.toHaveProperty("removed");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("--dry-run in json mode reports a pending VS Code update without writing it", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
      yield* writeFile([".vscode", "settings.json"], "{}\n");

      yield* run(true).pipe(Effect.provide(layer));

      expect(out.messages[0]).toMatchObject({
        data: { would_update_vscode_settings: true },
      });
      expect(yield* readFile(".vscode", "settings.json")).toBe("{}\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps an explicit trusted-domain choice in VS Code settings", () => {
    const { layer, out } = setup();
    const settings =
      '{\n  "json.schemaDownload.trustedDomains": {\n    "https://supabase.com/schemas/": false\n  }\n}\n';
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);
      yield* writeFile([".vscode", "settings.json"], settings);

      yield* run().pipe(Effect.provide(layer));

      expect(yield* readFile(".vscode", "settings.json")).toBe(settings);
      expect(out.stdoutText).not.toContain(".vscode/settings.json");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("prints no conversion report when config.toml cannot be removed", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(Layer.provideMerge(failingConfigTomlFsLayer("remove"), layer)),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertWriteError");
      expect(error.message).toContain("could not remove supabase/config.toml");
      expect(yield* exists("supabase", "config.jsonc")).toBe(true);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("maps a failed re-read of config.toml to a write error, not a changed file", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(Layer.provideMerge(failingConfigTomlFsLayer("reread"), layer)),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertWriteError");
      expect(error.message).toContain("Could not re-read supabase/config.toml");
      expect(error.message).toContain("PermissionDenied");
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("leaves a config.jsonc that appears mid-run in place and keeps config.toml", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(Layer.provideMerge(failingConfigTomlFsLayer("jsonc-appears"), layer)),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertFileChangedError");
      expect(error.message).toBe(JSONC_APPEARED_MESSAGE);
      expect(yield* readFile("supabase", "config.jsonc")).toBe("{}\n");
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps config.toml when config.jsonc is removed mid-run", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(Layer.provideMerge(failingConfigTomlFsLayer("jsonc-removed"), layer)),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertFileChangedError");
      expect(error.message).toBe(JSONC_VANISHED_MESSAGE);
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps config.toml and removes config.jsonc when config.json appears mid-run", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(Layer.provideMerge(failingConfigTomlFsLayer("json-appears"), layer)),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertFileChangedError");
      expect(error.message).toBe(jsonAppearedMessage(JSONC_REMOVED_NOTE));
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
      expect(yield* readFile("supabase", "config.json")).toBe("{}\n");
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps a config.jsonc edited mid-run instead of rolling it back", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(Layer.provideMerge(failingConfigTomlFsLayer("both-edited"), layer)),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertFileChangedError");
      expect(error.message).toContain(JSONC_CHANGED_NOTE);
      expect(yield* readFile("supabase", "config.jsonc")).toBe('{ "edited": true }\n');
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("says config.jsonc remains when the rollback cannot remove it", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(
        Effect.provide(
          Layer.provideMerge(failingConfigTomlFsLayer("reread-and-jsonc-stuck"), layer),
        ),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigConvertWriteError");
      expect(error.message).toContain("Could not remove the new supabase/config.jsonc");
      expect(error.message).not.toContain("Removed supabase/config.jsonc");
      expect(yield* exists("supabase", "config.jsonc")).toBe(true);
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("rejects -o/--output in favour of --output-format", () => {
    const { layer } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], SIMPLE_TOML);

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertOutputFlagUnsupportedError");
      expect(error.message).toBe(
        "the -o/--output flag is not supported by config convert; use --output-format json|stream-json instead.",
      );
      expect(yield* readFile("supabase", "config.toml")).toBe(SIMPLE_TOML);
    }).pipe(Effect.provide(BunServices.layer));
  });
});
