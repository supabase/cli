import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { parseJsonc } from "@supabase/config/internal";
import { orioledbVersions } from "@supabase/stack/internal/artifacts";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stdio,
} from "effect";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  AgentFlag,
  ExperimentalFlag,
  WorkdirFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { textOutputLayer } from "../../shared/output/output.layer.ts";
import { Output } from "../../shared/output/output.service.ts";
import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput, mockRuntimeInfo, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { init } from "./init.handler.ts";

const tempRoot = useTempWorkdir("supabase-init-");

const decodeOrioleDbConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    db: Schema.Struct({ major_version: Schema.Finite, orioledb_version: Schema.String }),
  }),
);

const readTextFile = (...segments: Array<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(...segments));
  }).pipe(Effect.provide(BunServices.layer));

function setup(
  cwd: string,
  opts: {
    experimental?: boolean;
    workdir?: Option.Option<string>;
    interactive?: boolean;
    format?: "text" | "json";
    stdinIsTty?: boolean;
    yes?: boolean;
    /** Piped stdin lines consumed by the non-TTY IDE-settings confirm reads. */
    stdinInput?: string;
    platform?: NodeJS.Platform;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  const out = mockOutput({ format: opts.format ?? "text", interactive: opts.interactive ?? false });
  return {
    out,
    layer: Layer.mergeAll(
      BunServices.layer,
      out.layer,
      mockRuntimeInfo({ cwd, platform: opts.platform }),
      mockTty({
        stdinIsTty: opts.stdinIsTty ?? false,
        stdoutIsTty: opts.interactive ?? false,
      }),
      mockStdin(opts.stdinIsTty ?? false, opts.stdinInput),
      Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
      Layer.succeed(WorkdirFlag, opts.workdir ?? Option.none()),
      Layer.succeed(YesFlag, opts.yes ?? false),
      Layer.succeed(CliArgs, { args: [] }),
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(opts.env ?? {}, { preserveEmptyStrings: true }),
      ),
    ),
  };
}

function findFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return undefined;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  return Option.getOrUndefined(failure);
}

/**
 * Renders a handler failure exactly like the real CLI does and returns the captured stderr
 * writes (ANSI-stripped). Locks the composed stderr output, not just the error fields.
 */
function renderFailureToStderr(exit: Exit.Exit<unknown, unknown>) {
  return Effect.gen(function* () {
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      return [];
    }

    const writes: Array<string> = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(stripAnsi(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)));
      return true;
    }) as typeof process.stderr.write;

    yield* Effect.gen(function* () {
      const out = yield* Output;
      yield* out.fail(normalizeCause(exit.cause));
    }).pipe(
      Effect.provide(
        textOutputLayer.pipe(Layer.provide(Layer.mergeAll(mockTty({}), Stdio.layerTest({})))),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          process.stderr.write = originalWrite;
        }),
      ),
    );

    return writes;
  });
}

describe("init", () => {
  it.effect("creates config.jsonc natively", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir);

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "supabase", "config.jsonc");
      expect(parseJsonc(content)).toMatchObject({
        $schema: "https://supabase.com/schemas/config/v1.json",
        db: { major_version: 17 },
        api: { port: 54321 },
      });
      expect(content).not.toContain('"stack": true');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(tempDir, "supabase", "config.toml"))).toBe(false);
      expect(out.stdoutText).toBe("Finished supabase init.\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect.each([
    { experimental: false, label: "without --experimental" },
    { experimental: true, label: "with --experimental" },
  ])("writes OrioleDB config $label", ({ experimental }) => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { experimental });

      yield* init({
        interactive: false,
        useOrioledb: true,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "supabase", "config.jsonc");
      const { db } = yield* decodeOrioleDbConfig(parseJsonc(content));
      expect(db.major_version).toBe(17);
      expect(orioledbVersions()).toContain(db.orioledb_version);
      expect(out.stdoutText).toBe("Finished supabase init.\n");
    });
  });

  it.effect("fails with the exact error when config.jsonc already exists", () => {
    const tempDir = tempRoot.current;

    const initFlags = {
      interactive: false,
      useOrioledb: false,
      force: false,
      withVscodeWorkspace: false,
      withVscodeSettings: false,
      withIntellijSettings: false,
    };

    return Effect.gen(function* () {
      const { layer } = setup(tempDir);

      yield* init(initFlags).pipe(Effect.provide(layer));
      const exit = yield* init(initFlags).pipe(Effect.provide(layer), Effect.exit);

      const error = findFailure(exit);
      expect(Predicate.isTagged(error, "InitConfigExistsError")).toBe(true);
      expect(error).toMatchObject({
        message: "failed to create config file: open supabase/config.jsonc: file exists",
        suggestion: "Run supabase init --force to overwrite existing config file.",
      });

      expect(yield* renderFailureToStderr(exit)).toEqual([
        "failed to create config file: open supabase/config.jsonc: file exists\n",
        "Run supabase init --force to overwrite existing config file.\n",
      ]);
    });
  });

  it.effect.each([
    { existing: ["config.json", "config.jsonc", "config.toml"], named: "config.json" },
    { existing: ["config.jsonc", "config.toml"], named: "config.jsonc" },
    { existing: ["config.jsonc"], named: "config.jsonc" },
    { existing: ["config.toml"], named: "config.toml" },
  ])("names $named when $existing already exist", ({ existing, named }) => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
      for (const file of existing) {
        yield* fs.writeFileString(path.join(tempDir, "supabase", file), "{}\n");
      }
      const { layer } = setup(tempDir);

      const exit = yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer), Effect.exit);

      expect(findFailure(exit)).toMatchObject({
        message: `failed to create config file: open supabase/${named}: file exists`,
      });
      for (const file of existing) {
        expect(yield* fs.readFileString(path.join(tempDir, "supabase", file))).toBe("{}\n");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("--force writes config.jsonc and removes config.json and config.toml", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "supabase", "config.json"), "{}\n");
      yield* fs.writeFileString(path.join(tempDir, "supabase", "config.jsonc"), "{}\n");
      yield* fs.writeFileString(path.join(tempDir, "supabase", "config.toml"), "");
      const { layer } = setup(tempDir);

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: true,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      expect(yield* fs.exists(path.join(tempDir, "supabase", "config.json"))).toBe(false);
      expect(yield* fs.exists(path.join(tempDir, "supabase", "config.toml"))).toBe(false);
      expect(yield* readTextFile(tempDir, "supabase", "config.jsonc")).toContain("major_version");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "--force replaces a symlinked config.jsonc without writing through to its target",
    () => {
      const tempDir = tempRoot.current;

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const supabaseDir = path.join(tempDir, "supabase");
        const targetPath = path.join(tempDir, "shared-config.jsonc");
        const configPath = path.join(supabaseDir, "config.jsonc");
        yield* fs.makeDirectory(supabaseDir, { recursive: true });
        yield* fs.writeFileString(targetPath, "// shared\n{}\n");
        yield* fs.symlink(targetPath, configPath);
        const { layer } = setup(tempDir);

        yield* init({ ...BASE_INIT_FLAGS, interactive: false, force: true }).pipe(
          Effect.provide(layer),
        );

        expect(yield* fs.readLink(configPath).pipe(Effect.exit, Effect.map(Exit.isFailure))).toBe(
          true,
        );
        expect(parseJsonc(yield* fs.readFileString(configPath))).toMatchObject({
          db: { major_version: 17 },
        });
        expect(yield* fs.readFileString(targetPath)).toBe("// shared\n{}\n");
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("--force keeps config.json when config.jsonc cannot be written", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const supabaseDir = path.join(tempDir, "supabase");
      yield* fs.makeDirectory(supabaseDir, { recursive: true });
      yield* fs.writeFileString(path.join(supabaseDir, "config.json"), "{}\n");
      yield* fs.writeFileString(path.join(supabaseDir, "config.jsonc"), "");
      yield* fs.chmod(supabaseDir, 0o555);
      const { layer } = setup(tempDir);

      const exit = yield* Effect.exit(
        init({
          interactive: false,
          useOrioledb: false,
          force: true,
          withVscodeWorkspace: false,
          withVscodeSettings: false,
          withIntellijSettings: false,
        }).pipe(Effect.provide(layer)),
      ).pipe(Effect.ensuring(fs.chmod(supabaseDir, 0o755).pipe(Effect.ignore)));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.readFileString(path.join(supabaseDir, "config.json"))).toBe("{}\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("renders the Windows form of the already-exists error on win32", () => {
    const tempDir = tempRoot.current;

    const initFlags = {
      interactive: false,
      useOrioledb: false,
      force: false,
      withVscodeWorkspace: false,
      withVscodeSettings: false,
      withIntellijSettings: false,
    };

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { platform: "win32" });

      yield* init(initFlags).pipe(Effect.provide(layer));
      const exit = yield* init(initFlags).pipe(Effect.provide(layer), Effect.exit);

      const error = findFailure(exit);
      expect(Predicate.isTagged(error, "InitConfigExistsError")).toBe(true);
      expect(error).toMatchObject({
        message: "failed to create config file: open supabase\\config.jsonc: The file exists.",
        suggestion: "Run supabase init --force to overwrite existing config file.",
      });

      expect(yield* renderFailureToStderr(exit)).toEqual([
        "failed to create config file: open supabase\\config.jsonc: The file exists.\n",
        "Run supabase init --force to overwrite existing config file.\n",
      ]);
    });
  });

  it.effect("supports the hidden IDE flags natively", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir);

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: true,
        withVscodeSettings: false,
        withIntellijSettings: true,
      }).pipe(Effect.provide(layer));

      expect(yield* readTextFile(tempDir, ".vscode", "extensions.json")).toContain(
        '"recommendations"',
      );
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
      expect(yield* readTextFile(tempDir, ".idea", "deno.xml")).toContain(
        '<component name="DenoSettings">',
      );
      expect(out.stdoutText).toContain("Generated VS Code settings in .vscode/settings.json.");
      expect(out.stdoutText).toContain("Generated IntelliJ settings in .idea/deno.xml.");
    });
  });

  it.effect("respects the legacy --workdir global flag", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { workdir: Option.some("nested") });

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "nested", "supabase", "config.jsonc");
      expect(content).toContain('"major_version": 17');
    });
  });

  const BASE_INIT_FLAGS = {
    useOrioledb: false,
    force: false,
    withVscodeWorkspace: false,
    withVscodeSettings: false,
    withIntellijSettings: false,
  } as const;

  it.effect("init -i --yes writes VS Code settings instead of prompting", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: true, stdinIsTty: true, yes: true });

      yield* init({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(out.stderrText).not.toContain("IntelliJ");
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });

  it.effect("init -i with SUPABASE_YES=1 auto-accepts the VS Code prompt like --yes", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, {
        interactive: true,
        stdinIsTty: true,
        env: { SUPABASE_YES: "1" },
      });

      yield* init({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });

  it.effect("init -i --yes writes VS Code settings even when stdout is piped", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: false, stdinIsTty: true, yes: true });

      yield* init({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });

  it.effect("merges the VS Code settings into an existing file without losing user entries", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settingsPath = path.join(tempDir, ".vscode", "settings.json");
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fs.writeFileString(
        settingsPath,
        `{
  // user preferences
  "editor.fontSize": 14,
  "json.schemaDownload.trustedDomains": { "https://example.com/": true },
  "[typescript]": { "editor.tabSize": 4 },
}
`,
      );
      const { layer } = setup(tempDir);

      yield* init({ ...BASE_INIT_FLAGS, interactive: false, withVscodeSettings: true }).pipe(
        Effect.provide(layer),
      );

      const merged = yield* readTextFile(settingsPath);
      expect(merged).toContain("// user preferences");
      expect(parseJsonc(merged)).toMatchObject({
        "editor.fontSize": 14,
        "json.schemaDownload.trustedDomains": {
          "https://example.com/": true,
          "https://supabase.com/schemas/": true,
        },
        "[typescript]": {
          "editor.tabSize": 4,
          "editor.defaultFormatter": "denoland.vscode-deno",
        },
      });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect.each([
    ["malformed JSON", `{ "a": }`],
    ["a non-object document", "[]"],
  ] as const)(
    "fails with InitParseSettingsError for %s and leaves settings.json unchanged",
    ([, contents]) => {
      const tempDir = tempRoot.current;

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settingsPath = path.join(tempDir, ".vscode", "settings.json");
        yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(settingsPath, contents);
        const { layer } = setup(tempDir);

        const exit = yield* init({
          ...BASE_INIT_FLAGS,
          interactive: false,
          withVscodeSettings: true,
        }).pipe(Effect.provide(layer), Effect.exit);

        const error = findFailure(exit);
        expect(Predicate.isTagged(error, "InitParseSettingsError")).toBe(true);
        const detail = (error as { detail: string }).detail;
        expect(detail.startsWith(`Could not parse JSON in ${settingsPath}: `)).toBe(true);
        expect(detail.length).toBeGreaterThan(`Could not parse JSON in ${settingsPath}: `.length);
        expect(yield* readTextFile(settingsPath)).toBe(contents);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  describe("VS Code schema trust", () => {
    const TRUST_KEY = "json.schemaDownload.trustedDomains";
    const SETTINGS_WITH_COMMENT = `{
  // keep me
  "editor.fontSize": 14,
}
`;

    const writeSettings = (tempDir: string, contents: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settingsPath = path.join(tempDir, ".vscode", "settings.json");
        yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(settingsPath, contents);
        return settingsPath;
      }).pipe(Effect.provide(BunServices.layer));

    it.effect("trusts the schema domain in an existing settings.json and keeps its content", () => {
      const tempDir = tempRoot.current;

      return Effect.gen(function* () {
        const settingsPath = yield* writeSettings(tempDir, SETTINGS_WITH_COMMENT);
        const { layer, out } = setup(tempDir);

        yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

        const updated = yield* readTextFile(settingsPath);
        expect(updated).toContain("// keep me");
        expect(parseJsonc(updated)).toMatchObject({
          "editor.fontSize": 14,
          [TRUST_KEY]: { "https://supabase.com/schemas/": true },
        });
        expect(out.stdoutText).toContain(
          "Updated .vscode/settings.json (trusts https://supabase.com/schemas/).",
        );
      });
    });

    it.effect("does not create .vscode when the project has none", () => {
      const tempDir = tempRoot.current;

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layer, out } = setup(tempDir);

        yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

        expect(yield* fs.exists(path.join(tempDir, ".vscode"))).toBe(false);
        expect(out.stdoutText).not.toContain(".vscode/settings.json");
      }).pipe(Effect.provide(BunServices.layer));
    });

    it.effect("warns and leaves an unparseable settings.json untouched while init succeeds", () => {
      const tempDir = tempRoot.current;
      const broken = `{ "a": }`;

      return Effect.gen(function* () {
        const settingsPath = yield* writeSettings(tempDir, broken);
        const { layer, out } = setup(tempDir);

        yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

        expect(yield* readTextFile(settingsPath)).toBe(broken);
        expect(yield* readTextFile(tempDir, "supabase", "config.jsonc")).toContain("major_version");
        expect(out.stderrText).toContain("Warning: Could not update .vscode/settings.json:");
        expect(out.stderrText).toContain(
          'Add "https://supabase.com/schemas/": true under "json.schemaDownload.trustedDomains"',
        );
        expect(out.stdoutText).not.toContain("Updated .vscode/settings.json");
      });
    });

    it.effect("leaves settings.json byte-identical in json output mode", () => {
      const tempDir = tempRoot.current;
      const broken = `{ "a": }`;

      return Effect.gen(function* () {
        const settingsPath = yield* writeSettings(tempDir, SETTINGS_WITH_COMMENT);
        const { layer, out } = setup(tempDir, { format: "json" });

        yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

        expect(yield* readTextFile(settingsPath)).toBe(SETTINGS_WITH_COMMENT);
        expect(out.stdoutText).not.toContain("Updated .vscode/settings.json");

        yield* writeSettings(tempDir, broken);
        yield* init({ ...BASE_INIT_FLAGS, interactive: false, force: true }).pipe(
          Effect.provide(layer),
        );
        expect(yield* readTextFile(settingsPath)).toBe(broken);
        expect(out.stderrText).not.toContain("Warning");
      });
    });
  });

  it.effect("writes the stack-opt-in template when SUPABASE_EXPERIMENTAL_STACK=1", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { env: { SUPABASE_EXPERIMENTAL_STACK: "1" } });

      yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "supabase", "config.jsonc");
      expect(content).toContain('"stack": true');
      expect(content).not.toMatch(/^\s*"shadow_port": 54320,?$/m);
      expect(content).not.toMatch(/^\s*"port": 54321,?$/m);
      expect(content).not.toMatch(/^\s*"inspector_port": 8083,?$/m);
      expect(out.stdoutText).toBe("Finished supabase init.\n");
    });
  });

  it.effect.each([
    {
      env: {},
      interactive: true,
      expected:
        "run `SUPABASE_EXPERIMENTAL_STACK=1 supabase init --force`.\nThat replaces supabase/config.jsonc, so only run it before you edit the file.",
    },
    {
      env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
      interactive: true,
      expected: "Experimental local stack enabled in supabase/config.jsonc",
    },
    { env: {}, interactive: false, expected: undefined },
    { env: { SUPABASE_EXPERIMENTAL_STACK: "0" }, interactive: true, expected: undefined },
    {
      env: {},
      interactive: false,
      agent: true,
      expected:
        "Coding agents: offer this to the user and ask before changing supabase/config.jsonc",
    },
  ])(
    "stack note (interactive=$interactive, agent=$agent, env=$env)",
    ({ env, interactive, agent, expected }) => {
      const tempDir = tempRoot.current;

      return Effect.gen(function* () {
        const { layer, out } = setup(tempDir, { env, interactive });

        yield* init({
          interactive: false,
          useOrioledb: false,
          force: false,
          withVscodeWorkspace: false,
          withVscodeSettings: false,
          withIntellijSettings: false,
        }).pipe(
          Effect.provide(
            agent === true
              ? Layer.mergeAll(layer, Layer.succeed(AgentFlag, "yes" as const))
              : layer,
          ),
        );

        if (expected === undefined) {
          expect(out.stderrText).not.toContain("local stack");
        } else {
          expect(out.stderrText).toContain(expected);
        }
      });
    },
  );

  it.effect.each([
    {
      name: "keeps --use-orioledb",
      flags: { useOrioledb: true },
      platform: undefined,
      expected: "`SUPABASE_EXPERIMENTAL_STACK=1 supabase init --force --use-orioledb`",
    },
    {
      name: "uses PowerShell syntax on Windows",
      flags: {},
      platform: "win32" as const,
      expected: "`$env:SUPABASE_EXPERIMENTAL_STACK=1; supabase init --force`",
    },
  ])("stack note rerun command $name", ({ flags, platform, expected }) => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: true, platform });

      yield* init({ ...BASE_INIT_FLAGS, interactive: false, ...flags }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(expected);
    });
  });

  it.effect("stack note rerun command keeps --workdir as the resolved, quoted path", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const { layer, out } = setup(tempDir, {
        interactive: true,
        workdir: Option.some("my project"),
      });

      yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(
        `\`SUPABASE_EXPERIMENTAL_STACK=1 supabase init --force --workdir '${path.join(tempDir, "my project")}'\``,
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps the established template when SUPABASE_EXPERIMENTAL_STACK=0", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { env: { SUPABASE_EXPERIMENTAL_STACK: "0" } });

      yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "supabase", "config.jsonc");
      expect(content).not.toContain('"stack": true');
      expect(content).toContain('"port": 54321');
    });
  });

  it.effect("fails closed when SUPABASE_EXPERIMENTAL_STACK is not a boolean", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { env: { SUPABASE_EXPERIMENTAL_STACK: "yes" } });

      const exit = yield* init({ ...BASE_INIT_FLAGS, interactive: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      const error = findFailure(exit);
      expect(Predicate.isTagged(error, "ExperimentalFeatureFlagError")).toBe(true);
      expect(error).toMatchObject({
        message:
          'Invalid SUPABASE_EXPERIMENTAL_STACK="yes" (sets experimental.stack): expected true or false.',
      });

      expect(yield* renderFailureToStderr(exit)).toEqual([
        'Invalid SUPABASE_EXPERIMENTAL_STACK="yes" (sets experimental.stack): expected true or false.\n',
        "Try rerunning the command with --debug to troubleshoot the error.\n",
      ]);
    });
  });
});
