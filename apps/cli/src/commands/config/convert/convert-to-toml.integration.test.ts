import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import {
  CommandTelemetryAttributes,
  type CommandTelemetryAttributeValues,
  type ConvertReason,
} from "../../../telemetry/command-telemetry-attributes.ts";
import { configConvert } from "./convert.handler.ts";
import { jsonSymlinkMessage, undoToTomlCommand } from "./convert-to-toml.format.ts";

const tempRoot = useTempWorkdir("supabase-config-convert-to-toml-");

const SIMPLE_JSONC = `{
  "$schema": "https://supabase.com/schemas/config/v1.json",
  // project name
  "project_id": "demo",
  "api": {
    "port": 54321, // default
  },
}
`;

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly interactive?: boolean;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly consent?: "granted" | "denied";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    ...(opts.interactive === undefined ? {} : { interactive: opts.interactive }),
    ...(opts.promptSelectResponses === undefined
      ? {}
      : { promptSelectResponses: opts.promptSelectResponses }),
  });
  const telemetry = mockTelemetryStateTracked();
  const recorded: Array<CommandTelemetryAttributeValues> = [];
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: tempRoot.current, explicitWorkdir: false }),
    Layer.succeed(OutputFlag, Option.none()),
    mockRuntimeInfo({ cwd: tempRoot.current }),
    mockTty({ stdinIsTty: opts.interactive ?? false, stdoutIsTty: opts.interactive ?? false }),
    mockTelemetryRuntime({ consent: opts.consent ?? "granted" }),
    Layer.succeed(CommandTelemetryAttributes, {
      record: (values) => Effect.sync(() => void recorded.push(values)),
    }),
    BunServices.layer,
  );
  return { layer, out, recorded };
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

const run = (opts: { readonly dryRun?: boolean; readonly reason?: ConvertReason } = {}) =>
  configConvert({
    dryRun: opts.dryRun ?? false,
    to: "toml",
    reason: Option.fromNullishOr(opts.reason),
  });

const reasonsRecorded = (recorded: ReadonlyArray<CommandTelemetryAttributeValues>) =>
  recorded.flatMap((values) => ("convert_reason" in values ? [values.convert_reason] : []));

describe("config convert --to toml integration", () => {
  it.effect("writes config.toml and a backup, keeping the same config", () => {
    const { layer, out, recorded } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);
      const before = yield* materializedConfig();

      yield* run().pipe(Effect.provide(layer));

      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
      expect(yield* readFile("supabase", "config.jsonc.bak")).toBe(SIMPLE_JSONC);
      const toml = yield* readFile("supabase", "config.toml");
      expect(toml.startsWith("#:schema https://supabase.com/schemas/config/v1.json\n")).toBe(true);
      expect(toml).toContain('# project name\nproject_id = "demo"');
      expect(yield* materializedConfig()).toEqual(before);
      expect(out.stdoutText).toContain("Converted supabase/config.jsonc to supabase/config.toml");
      expect(out.stdoutText).toContain(
        undoToTomlCommand("", "supabase/config.jsonc.bak", "config.jsonc", "posix"),
      );
      expect(recorded).toContainEqual({ convert_target: "toml" });
      expect(recorded).toContainEqual({ convert_moved_comment_count: 0 });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("exits 0 when the project is already TOML", () => {
    const { layer, out, recorded } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], 'project_id = "demo"\n');

      yield* run().pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("supabase/config.toml is already TOML. Nothing to convert.\n");
      expect(yield* readFile("supabase", "config.toml")).toBe('project_id = "demo"\n');
      expect(recorded).toContainEqual({ convert_target: "toml" });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("refuses when config.toml exists next to config.jsonc", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);
      yield* writeFile(["supabase", "config.toml"], 'project_id = "other"\n');

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertTomlExistsError");
      expect(yield* readFile("supabase", "config.toml")).toBe('project_id = "other"\n');
      expect(yield* readFile("supabase", "config.jsonc")).toBe(SIMPLE_JSONC);
      expect(yield* exists("supabase", "config.jsonc.bak")).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("rejects --reason without --to toml", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], 'project_id = "demo"\n');

      const error = yield* configConvert({
        dryRun: false,
        to: "json",
        reason: Option.some("editor"),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertReasonWithoutTomlTargetError");
      expect(yield* exists("supabase", "config.toml.bak")).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("writes nothing and does not prompt on --dry-run", () => {
    const { layer, out, recorded } = setup({ interactive: true });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run({ dryRun: true }).pipe(Effect.provide(layer));

      expect(yield* readFile("supabase", "config.jsonc")).toBe(SIMPLE_JSONC);
      expect(yield* exists("supabase", "config.toml")).toBe(false);
      expect(yield* exists("supabase", "config.jsonc.bak")).toBe(false);
      expect(out.stdoutText).toContain('project_id = "demo"');
      expect(out.promptSelectCalls).toEqual([]);
      expect(reasonsRecorded(recorded)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("records the --reason flag without prompting", () => {
    const { layer, out, recorded } = setup({ interactive: true });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run({ reason: "older-cli" }).pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toEqual([]);
      expect(reasonsRecorded(recorded)).toEqual(["older-cli"]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("records the prompted reason on an interactive terminal", () => {
    const { layer, out, recorded } = setup({
      interactive: true,
      promptSelectResponses: ["editor"],
    });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run().pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toHaveLength(1);
      expect(reasonsRecorded(recorded)).toEqual(["editor"]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("does not ask for a reason when telemetry is opted out", () => {
    const { layer, out, recorded } = setup({ interactive: true, consent: "denied" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run().pipe(Effect.provide(layer));

      expect(yield* exists("supabase", "config.toml")).toBe(true);
      expect(out.promptSelectCalls).toEqual([]);
      expect(reasonsRecorded(recorded)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("offers Skip first and keeps a cancelled prompt silent", () => {
    const { layer, out } = setup({ interactive: true });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run().pipe(Effect.provide(layer));

      const [call] = out.promptSelectCalls;
      expect(call?.options[0]).toEqual({ value: "skip", label: "Skip" });
      expect(call?.behavior).toEqual({ silentCancel: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("records the target when the config cannot be read", () => {
    const { layer, recorded } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], "{ not json");

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertLoadConfigError");
      expect(recorded).toContainEqual({ convert_target: "toml" });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("records the target when no config exists", () => {
    const { layer, recorded } = setup();
    return Effect.gen(function* () {
      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertLoadConfigError");
      expect(recorded).toContainEqual({ convert_target: "toml" });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("reports a comment moved from the top level as such", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(
        ["supabase", "config.jsonc"],
        '{\n  "api": { "port": 1 }\n  // trailing root note\n}\n',
      );

      yield* run().pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("line 3 → top level");
      expect(out.stdoutText).not.toMatch(/line 3 → {2}/);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("records no reason when the prompt is skipped", () => {
    const { layer, recorded } = setup({ interactive: true, promptSelectResponses: ["skip"] });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run().pipe(Effect.provide(layer));

      expect(yield* exists("supabase", "config.toml")).toBe(true);
      expect(reasonsRecorded(recorded)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("does not prompt in a non-interactive run", () => {
    const { layer, out, recorded } = setup({ interactive: false });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run().pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toEqual([]);
      expect(reasonsRecorded(recorded)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("converts a config.json source and backs it up as config.json.bak", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.json"], '{ "project_id": "demo" }\n');

      yield* run().pipe(Effect.provide(layer));

      expect(yield* exists("supabase", "config.json")).toBe(false);
      expect(yield* readFile("supabase", "config.json.bak")).toBe('{ "project_id": "demo" }\n');
      expect(yield* exists("supabase", "config.jsonc.bak")).toBe(false);
      expect(yield* readFile("supabase", "config.toml")).toContain('project_id = "demo"');
      expect(out.stdoutText).toContain("supabase/config.json.bak");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("picks the next free numbered backup when config.jsonc.bak exists", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);
      yield* writeFile(["supabase", "config.jsonc.bak"], "older backup\n");

      yield* run().pipe(Effect.provide(layer));

      expect(yield* readFile("supabase", "config.jsonc.bak")).toBe("older backup\n");
      expect(yield* readFile("supabase", "config.jsonc.2.bak")).toBe(SIMPLE_JSONC);
      expect(yield* exists("supabase", "config.toml")).toBe(true);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("refuses a null value, names the file and leaves every file untouched", () => {
    const { layer, recorded } = setup();
    const source = '{\n  "project_id": "demo",\n  "api": { "port": null }\n}\n';
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], source);

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertUnsupportedError");
      expect(error.message).toContain("supabase/config.jsonc at line 3");
      expect(error.message).toContain("null");
      expect(error.message).toContain("supabase/config.jsonc was not changed");
      expect(yield* readFile("supabase", "config.jsonc")).toBe(source);
      expect(yield* exists("supabase", "config.toml")).toBe(false);
      expect(yield* exists("supabase", "config.jsonc.bak")).toBe(false);
      expect(recorded).toContainEqual({ convert_target: "toml" });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("refuses a symlinked config.jsonc and leaves the link in place", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* writeFile(["shared", "real.jsonc"], SIMPLE_JSONC);
      yield* writeFile(["supabase", "placeholder"], "");
      yield* fs.symlink("../shared/real.jsonc", yield* projectPath("supabase", "config.jsonc"));

      const error = yield* run().pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("ConfigConvertUnsupportedError");
      expect(error.message).toBe(jsonSymlinkMessage("config.jsonc"));
      expect(yield* fs.readLink(yield* projectPath("supabase", "config.jsonc"))).toBe(
        "../shared/real.jsonc",
      );
      expect(yield* readFile("shared", "real.jsonc")).toBe(SIMPLE_JSONC);
      expect(yield* exists("supabase", "config.toml")).toBe(false);
      expect(yield* exists("supabase", "config.jsonc.bak")).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("gives config.toml the permissions of the config.jsonc it replaces", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);
      yield* fs.chmod(yield* projectPath("supabase", "config.jsonc"), 0o600);

      yield* run().pipe(Effect.provide(layer));

      const info = yield* fs.stat(yield* projectPath("supabase", "config.toml"));
      expect(info.mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("reports nothing converted in json mode when the project is already TOML", () => {
    const { layer, out, recorded } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.toml"], 'project_id = "demo"\n');

      yield* run().pipe(Effect.provide(layer));

      expect(out.messages).toEqual([
        {
          type: "success",
          message: "supabase/config.toml is already TOML. Nothing to convert.",
          data: { converted: false, path: "supabase/config.toml", format: "toml" },
        },
      ]);
      expect(recorded).toContainEqual({ convert_target: "toml" });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("leaves .vscode/settings.json untouched", () => {
    const { layer, out } = setup();
    const settings = '{\n  // mine\n  "editor.fontSize": 14\n}\n';
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);
      yield* writeFile([".vscode", "settings.json"], settings);

      yield* run().pipe(Effect.provide(layer));

      expect(yield* readFile(".vscode", "settings.json")).toBe(settings);
      expect(out.stdoutText).not.toContain(".vscode");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("round-trips TOML to JSONC and back to TOML through the command", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeFile(
        ["supabase", "config.toml"],
        '# my project\nproject_id = "demo"\n\n[api]\nport = 54321 # default port\n# db_pool = 10\n',
      );
      const before = yield* materializedConfig();

      yield* configConvert({ dryRun: false, to: "json", reason: Option.none() }).pipe(
        Effect.provide(layer),
      );
      yield* run().pipe(Effect.provide(layer));

      expect(yield* materializedConfig()).toEqual(before);
      expect(yield* exists("supabase", "config.jsonc")).toBe(false);
      expect(yield* exists("supabase", "config.toml.bak")).toBe(true);
      expect(yield* exists("supabase", "config.jsonc.bak")).toBe(true);
      const toml = yield* readFile("supabase", "config.toml");
      expect(toml).toContain("# my project");
      expect(toml).toContain("# default port");
      expect(toml).toContain("# db_pool = 10");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("emits the machine payload with target toml and never prompts", () => {
    const { layer, out } = setup({ format: "json", interactive: true });
    return Effect.gen(function* () {
      yield* writeFile(["supabase", "config.jsonc"], SIMPLE_JSONC);

      yield* run().pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toEqual([]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            target: "toml",
            converted: true,
            path: "supabase/config.toml",
            backup: "supabase/config.jsonc.bak",
          }),
        }),
      );
    }).pipe(Effect.provide(BunServices.layer));
  });
});
