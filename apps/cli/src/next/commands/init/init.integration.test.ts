import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Cause, Effect, Exit, Layer, Option, Stdio } from "effect";
import { Command } from "effect/unstable/cli";
import { INIT_GITIGNORE_TEMPLATE } from "../../../shared/init/project-init.templates.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { initCommand } from "./init.command.ts";
import { init } from "./init.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-init-command-"));
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

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) {
    expect((failure.value as { _tag: string })._tag).toBe(tag);
  }
}

describe("init handler", () => {
  it.live("creates config.toml and supabase/.gitignore", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".git"), { recursive: true }));
      const { layer, out } = buildLayer(tempDir);

      yield* init({
        interactive: false,
        experimental: false,
        useOrioledb: false,
        force: false,
      }).pipe(Effect.provide(layer));

      const configPath = join(tempDir, "supabase", "config.toml");
      const content = yield* Effect.tryPromise(() => readFile(configPath, "utf8"));

      expect(content).toContain(`project_id = "${basename(tempDir)}"`);
      expect(content).toContain("major_version = 17");
      expect(content).toContain('orioledb_version = ""');
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, "supabase", ".gitignore"), "utf8")),
      ).toBe(INIT_GITIGNORE_TEMPLATE);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Initialized Supabase project.",
          data: expect.objectContaining({ config_path: configPath, created: true }),
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("reports an already-initialized project without overwriting it", () => {
    const tempDir = makeTempDir();
    const configPath = join(tempDir, "supabase", "config.toml");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(configPath, 'project_id = "existing"\n'));
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
      expect(yield* Effect.tryPromise(() => readFile(configPath, "utf8"))).toBe(
        'project_id = "existing"\n',
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("ignores a legacy config.json when creating config.toml", () => {
    const tempDir = makeTempDir();
    const jsonPath = join(tempDir, "supabase", "config.json");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(jsonPath, '{ "$schema": "./schema.json" }\n'));
      const { layer } = buildLayer(tempDir);

      yield* init({
        interactive: false,
        experimental: false,
        useOrioledb: false,
        force: false,
      }).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, "supabase", "config.toml"), "utf8")),
      ).toContain(`project_id = "${basename(tempDir)}"`);
      expect(yield* Effect.tryPromise(() => readFile(jsonPath, "utf8"))).toBe(
        '{ "$schema": "./schema.json" }\n',
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("does not remove a legacy config.json when force is set", () => {
    const tempDir = makeTempDir();
    const jsonPath = join(tempDir, "supabase", "config.json");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(jsonPath, '{ "$schema": "./schema.json" }\n'));
      const { layer } = buildLayer(tempDir);

      yield* init({
        interactive: false,
        experimental: false,
        useOrioledb: false,
        force: true,
      }).pipe(Effect.provide(layer));

      const content = yield* Effect.tryPromise(() =>
        readFile(join(tempDir, "supabase", "config.toml"), "utf8"),
      );
      expect(content).toContain(`project_id = "${basename(tempDir)}"`);
      expect(yield* Effect.tryPromise(() => readFile(jsonPath, "utf8"))).toBe(
        '{ "$schema": "./schema.json" }\n',
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("writes the OrioleDB version when requested", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer } = buildLayer(tempDir);

      yield* init({ interactive: false, experimental: true, useOrioledb: true, force: false }).pipe(
        Effect.provide(layer),
      );

      const content = yield* Effect.tryPromise(() =>
        readFile(join(tempDir, "supabase", "config.toml"), "utf8"),
      );
      expect(content).toContain('orioledb_version = "15.1.0.150"');
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prompts for IDE settings in interactive mode", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
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

      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".vscode", "settings.json"), "utf8")),
      ).toContain('"deno.enablePaths"');
      expect(out.stdoutText).toContain("Generated VS Code settings in .vscode/settings.json.");
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Initialized Supabase project." }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("overwrites nested VS Code formatter settings the same way as the old init flow", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".vscode"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          join(tempDir, ".vscode", "settings.json"),
          JSON.stringify(
            {
              custom: true,
              "[typescript]": {
                "editor.tabSize": 4,
              },
            },
            null,
            2,
          ),
        ),
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

      const settings = JSON.parse(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".vscode", "settings.json"), "utf8")),
      ) as Record<string, unknown>;

      expect(settings.custom).toBe(true);
      expect(settings["[typescript]"]).toEqual({
        "editor.defaultFormatter": "denoland.vscode-deno",
      });
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("merges into a JSONC settings file with comments and trailing commas", () => {
    const tempDir = makeTempDir();
    const settingsPath = join(tempDir, ".vscode", "settings.json");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".vscode"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          settingsPath,
          [
            "{",
            "  // editor preferences",
            '  "editor.tabSize": 4, // keep four spaces',
            "  /* a block comment */",
            '  "files.eol": "\\n",',
            "}",
          ].join("\n"),
        ),
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

      const settings = JSON.parse(
        yield* Effect.tryPromise(() => readFile(settingsPath, "utf8")),
      ) as Record<string, unknown>;

      expect(settings["editor.tabSize"]).toBe(4);
      expect(settings["files.eol"]).toBe("\n");
      expect(settings["deno.enablePaths"]).toBeDefined();
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "fails with InitParseSettingsError on a malformed settings file without clobbering it",
    () => {
      const tempDir = makeTempDir();
      const settingsPath = join(tempDir, ".vscode", "settings.json");
      const malformed = '{ "editor.tabSize": ';

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => mkdir(join(tempDir, ".vscode"), { recursive: true }));
        yield* Effect.tryPromise(() => writeFile(settingsPath, malformed));
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
        expect(yield* Effect.tryPromise(() => readFile(settingsPath, "utf8"))).toBe(malformed);
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("does not prompt for IDE settings when stdin is not a TTY", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
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
      expect(
        yield* Effect.tryPromise(async () => {
          try {
            await readFile(join(tempDir, ".vscode", "settings.json"), "utf8");
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("only writes supabase/.gitignore inside a git repo", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer } = buildLayer(tempDir);

      yield* init({
        interactive: false,
        experimental: false,
        useOrioledb: false,
        force: false,
      }).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(async () => {
          try {
            await readFile(join(tempDir, "supabase", ".gitignore"), "utf8");
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("appends to an existing supabase/.gitignore without clobbering it", () => {
    const tempDir = makeTempDir();
    const gitignorePath = join(tempDir, "supabase", ".gitignore");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".git"), { recursive: true }));
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(gitignorePath, "existing-entry\n"));
      const { layer } = buildLayer(tempDir);

      yield* init({
        interactive: false,
        experimental: false,
        useOrioledb: false,
        force: false,
      }).pipe(Effect.provide(layer));

      expect(yield* Effect.tryPromise(() => readFile(gitignorePath, "utf8"))).toBe(
        `existing-entry\n\n${INIT_GITIGNORE_TEMPLATE}`,
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("requires --experimental when --use-orioledb is set", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer } = buildLayer(tempDir);

      const exit = yield* init({
        interactive: false,
        experimental: false,
        useOrioledb: true,
        force: false,
      }).pipe(Effect.provide(layer), Effect.exit);

      expectFailureTag(exit, "InitExperimentalRequiredError");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("emits a canonical command event with no default flag values", () => {
    const tempDir = makeTempDir();
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
      yield* Command.runWith(initCommand, { version: "0.1.0" })(["init"]).pipe(
        Effect.provide(layer),
      );

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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("wires command flags through the parser", () => {
    const tempDir = makeTempDir();
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
        "init",
        "--experimental",
        "--use-orioledb",
      ]).pipe(Effect.provide(layer));

      const content = yield* Effect.tryPromise(() =>
        readFile(join(tempDir, "supabase", "config.toml"), "utf8"),
      );
      expect(content).toContain('orioledb_version = "15.1.0.150"');
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
