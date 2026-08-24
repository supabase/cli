import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, FileSystem, Exit, Layer, Option, Path, Schema, Stdio } from "effect";
import { Command } from "effect/unstable/cli";
import { INIT_GITIGNORE_TEMPLATE } from "../../../shared/init/project-init.templates.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { initCommand } from "./init.command.ts";
import { init } from "./init.handler.ts";

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function withTempDir<A, E>(
  body: (tempDir: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, never>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-init-command-" });
      return yield* body(tempDir, fs, path);
    }).pipe(Effect.provide(BunServices.layer)),
  );
}

function buildLayer(
  cwd: string,
  opts: {
    interactive?: boolean;
    stdinIsTty?: boolean;
    promptConfirmResponses?: ReadonlyArray<boolean>;
  } = {},
) {
  const runtimeInfoLayer = mockRuntimeInfo({ cwd });
  const out = mockOutput({
    format: "text",
    interactive: opts.interactive ?? false,
    promptConfirmResponses: opts.promptConfirmResponses,
  });

  return {
    out,
    layer: Layer.mergeAll(
      out.layer,
      runtimeInfoLayer,
      mockTty({
        stdinIsTty: opts.stdinIsTty ?? false,
        stdoutIsTty: opts.interactive ?? false,
      }),
      mockStdin(opts.stdinIsTty ?? false),
      BunServices.layer,
    ),
  };
}

function mockContextualAnalytics() {
  const captured: Array<{
    event: string;
    properties: Record<string, unknown>;
  }> = [];

  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({
            event,
            properties: {
              ...context,
              ...properties,
            },
          });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );

  return { layer, captured };
}

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string): Record<string, unknown> {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return {};
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) {
    return {};
  }
  const error = failure.value as Record<string, unknown>;
  expect(error["_tag"]).toBe(tag);
  return error;
}

describe("init handler", () => {
  it.live("creates config.toml and supabase/.gitignore", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(tempDir, ".git"), { recursive: true });
        const { layer, out } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        const configPath = path.join(tempDir, "supabase", "config.toml");
        const content = yield* fs.readFileString(configPath);

        expect(content).toContain(`project_id = "${path.basename(tempDir)}"`);
        expect(content).toContain("major_version = 17");
        expect(content).toContain('orioledb_version = ""');
        expect(yield* fs.readFileString(path.join(tempDir, "supabase", ".gitignore"))).toBe(
          INIT_GITIGNORE_TEMPLATE,
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "Initialized Supabase project.",
            data: expect.objectContaining({ config_path: configPath, created: true }),
          }),
        );
      }),
    );
  });

  it.live("reports an already-initialized project without overwriting it", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const configPath = path.join(tempDir, "supabase", "config.toml");
        yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(configPath, 'project_id = "existing"\n');
        const { layer, out } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "Supabase project already initialized.",
            data: expect.objectContaining({ config_path: configPath, created: false }),
          }),
        );
        expect(yield* fs.readFileString(configPath)).toBe('project_id = "existing"\n');
      }),
    );
  });

  it.live("ignores a legacy config.json when creating config.toml", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const jsonPath = path.join(tempDir, "supabase", "config.json");
        yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, '{ "$schema": "./schema.json" }\n');
        const { layer } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        expect(yield* fs.readFileString(path.join(tempDir, "supabase", "config.toml"))).toContain(
          `project_id = "${path.basename(tempDir)}"`,
        );
        expect(yield* fs.readFileString(jsonPath)).toBe('{ "$schema": "./schema.json" }\n');
      }),
    );
  });

  it.live("does not remove a legacy config.json when force is set", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const jsonPath = path.join(tempDir, "supabase", "config.json");
        yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, '{ "$schema": "./schema.json" }\n');
        const { layer } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: true,
        }).pipe(Effect.provide(layer));

        const content = yield* fs.readFileString(path.join(tempDir, "supabase", "config.toml"));
        expect(content).toContain(`project_id = "${path.basename(tempDir)}"`);
        expect(yield* fs.readFileString(jsonPath)).toBe('{ "$schema": "./schema.json" }\n');
      }),
    );
  });

  it.live("writes the OrioleDB version when requested", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const { layer } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: true,
          useOrioledb: true,
          force: false,
        }).pipe(Effect.provide(layer));

        const content = yield* fs.readFileString(path.join(tempDir, "supabase", "config.toml"));
        expect(content).toContain('orioledb_version = "15.1.0.150"');
      }),
    );
  });

  it.live("prompts for IDE settings in interactive mode", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const { layer, out } = buildLayer(tempDir, {
          interactive: true,
          stdinIsTty: true,
          promptConfirmResponses: [true],
        });

        yield* init({
          interactive: true,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        expect(yield* fs.readFileString(path.join(tempDir, ".vscode", "settings.json"))).toContain(
          '"deno.enablePaths"',
        );
        expect(out.stdoutText).toContain("Generated VS Code settings in .vscode/settings.json.");
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "success", message: "Initialized Supabase project." }),
        );
      }),
    );
  });

  it.live("overwrites nested VS Code formatter settings the same way as the old init flow", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(tempDir, ".vscode"), { recursive: true });
        yield* fs.writeFileString(
          path.join(tempDir, ".vscode", "settings.json"),
          encodeJson({
            custom: true,
            "[typescript]": {
              "editor.tabSize": 4,
            },
          }),
        );
        const { layer } = buildLayer(tempDir, {
          interactive: true,
          stdinIsTty: true,
          promptConfirmResponses: [true],
        });

        yield* init({
          interactive: true,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        const settings = yield* decodeJson(
          yield* fs.readFileString(path.join(tempDir, ".vscode", "settings.json")),
        );

        expect(settings.custom).toBe(true);
        expect(settings["[typescript]"]).toEqual({
          "editor.defaultFormatter": "denoland.vscode-deno",
        });
      }),
    );
  });

  it.live("merges into a JSONC settings file with comments and trailing commas", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const settingsPath = path.join(tempDir, ".vscode", "settings.json");
        yield* fs.makeDirectory(path.join(tempDir, ".vscode"), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          [
            "{",
            "  // editor preferences",
            '  "editor.tabSize": 4, // keep four spaces',
            "  /* a block comment */",
            '  "files.eol": "\\n",',
            "}",
          ].join("\n"),
        );
        const { layer } = buildLayer(tempDir, {
          interactive: true,
          stdinIsTty: true,
          promptConfirmResponses: [true],
        });

        yield* init({
          interactive: true,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        const settings = yield* decodeJson(yield* fs.readFileString(settingsPath));

        expect(settings["editor.tabSize"]).toBe(4);
        expect(settings["files.eol"]).toBe("\n");
        expect(settings["deno.enablePaths"]).toBeDefined();
      }),
    );
  });

  it.live(
    "fails with InitParseSettingsError on a malformed settings file without clobbering it",
    () => {
      return withTempDir((tempDir, fs, path) =>
        Effect.gen(function* () {
          const settingsPath = path.join(tempDir, ".vscode", "settings.json");
          const malformed = '{ "editor.tabSize": ';
          yield* fs.makeDirectory(path.join(tempDir, ".vscode"), { recursive: true });
          yield* fs.writeFileString(settingsPath, malformed);
          const { layer } = buildLayer(tempDir, {
            interactive: true,
            stdinIsTty: true,
            promptConfirmResponses: [true],
          });

          const exit = yield* init({
            interactive: true,
            experimental: false,
            useOrioledb: false,
            force: false,
          }).pipe(Effect.provide(layer), Effect.exit);

          expectFailureTag(exit, "InitParseSettingsError");
          expect(yield* fs.readFileString(settingsPath)).toBe(malformed);
        }),
      );
    },
  );

  it.live("does not prompt for IDE settings when stdin is not a TTY", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const { layer, out } = buildLayer(tempDir, {
          interactive: true,
          stdinIsTty: false,
          promptConfirmResponses: [true],
        });

        yield* init({
          interactive: true,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "success", message: "Initialized Supabase project." }),
        );
        expect(out.stdoutText).not.toContain("Generated VS Code settings");
        expect(yield* fs.exists(path.join(tempDir, ".vscode", "settings.json"))).toBe(false);
      }),
    );
  });

  it.live("only writes supabase/.gitignore inside a git repo", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const { layer } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        expect(yield* fs.exists(path.join(tempDir, "supabase", ".gitignore"))).toBe(false);
      }),
    );
  });

  it.live("appends to an existing supabase/.gitignore without clobbering it", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const gitignorePath = path.join(tempDir, "supabase", ".gitignore");
        yield* fs.makeDirectory(path.join(tempDir, ".git"), { recursive: true });
        yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(gitignorePath, "existing-entry\n");
        const { layer } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        expect(yield* fs.readFileString(gitignorePath)).toBe(
          `existing-entry\n\n${INIT_GITIGNORE_TEMPLATE}`,
        );
      }),
    );
  });

  it.live("prepends a line break even when the existing supabase/.gitignore is empty", () => {
    return withTempDir((tempDir, fs, path) =>
      Effect.gen(function* () {
        const gitignorePath = path.join(tempDir, "supabase", ".gitignore");
        yield* fs.makeDirectory(path.join(tempDir, ".git"), { recursive: true });
        yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(gitignorePath, "");
        const { layer } = buildLayer(tempDir);

        yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: false,
          force: false,
        }).pipe(Effect.provide(layer));

        // Go appends `\n` + template to any pre-existing file, even an empty one
        // (`apps/cli-go/internal/init/init.go:80-96`, deleted in CLI-1970; last
        // present at commit 7b469f5b3).
        expect(yield* fs.readFileString(gitignorePath)).toBe(`\n${INIT_GITIGNORE_TEMPLATE}`);
      }),
    );
  });

  it.live("requires --experimental when --use-orioledb is set", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        const { layer } = buildLayer(tempDir);

        const exit = yield* init({
          interactive: false,
          experimental: false,
          useOrioledb: true,
          force: false,
        }).pipe(Effect.provide(layer), Effect.exit);

        // The next shell deliberately keeps this friendlier wording; the legacy
        // shell matches Go's cobra message instead (CLI-1986).
        const error = expectFailureTag(exit, "InitExperimentalRequiredError");
        expect(error["message"]).toBe("The --use-orioledb flag requires --experimental.");
        expect(error["suggestion"]).toBe(
          "Rerun the command with `supabase init --experimental --use-orioledb`.",
        );
      }),
    );
  });

  it.live("emits a canonical command event with no default flag values", () => {
    return withTempDir((tempDir) => {
      const runtimeInfoLayer = mockRuntimeInfo({ cwd: tempDir });
      const processControl = mockProcessControl();
      const out = mockOutput({ format: "text", interactive: false });
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        BunServices.layer,
        out.layer,
        analytics.layer,
        runtimeInfoLayer,
        processControl.layer,
        mockTty(),
        Stdio.layerTest({
          args: Effect.succeed(["init"]),
        }),
      );

      return Effect.gen(function* () {
        yield* Command.runWith(initCommand, { version: "0.1.0" })([]).pipe(Effect.provide(layer));

        expect(analytics.captured).toHaveLength(1);
        expect(analytics.captured[0]).toEqual({
          event: "cli_command_executed",
          properties: expect.objectContaining({
            command: "init",
            flags_used: [],
            flag_values: {},
            exit_code: 0,
          }),
        });
      });
    });
  });

  it.live("wires command flags through the parser", () => {
    return withTempDir((tempDir, fs, path) => {
      const runtimeInfoLayer = mockRuntimeInfo({ cwd: tempDir });
      const out = mockOutput({ format: "text", interactive: false });
      const analytics = mockContextualAnalytics();
      const processControl = mockProcessControl();
      const layer = Layer.mergeAll(
        BunServices.layer,
        out.layer,
        analytics.layer,
        runtimeInfoLayer,
        mockTty(),
        processControl.layer,
      );

      return Effect.gen(function* () {
        yield* Command.runWith(initCommand, { version: "0.1.0" })([
          "--experimental",
          "--use-orioledb",
        ]).pipe(Effect.provide(layer));

        const content = yield* fs.readFileString(path.join(tempDir, "supabase", "config.toml"));
        expect(content).toContain('orioledb_version = "15.1.0.150"');
      });
    });
  });
});
