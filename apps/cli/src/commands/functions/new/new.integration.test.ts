import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
  withEnvVar,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import {
  FunctionsNewFileExistsError,
  FunctionsNewInvalidSlugError,
  FunctionsNewWorkdirError,
  FunctionsNewWriteError,
} from "./new.errors.ts";
import { functionsNew } from "./new.handler.ts";
import { FUNCTIONS_NEW_DENO_JSON, FUNCTIONS_NEW_NPMRC } from "./new.templates.ts";

const tempRoot = useTempWorkdir("supabase-functions-new-int-");

interface SetupOptions {
  readonly format?: "text" | "json" | "stream-json";
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly yes?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  /** Piped stdin lines consumed by the non-TTY IDE-settings confirm reads. */
  readonly stdinInput?: string;
  /** cliSettings.workdir override; defaults to the temp project root. */
  readonly workdir?: string;
  /** cliSettings.explicitWorkdir override — true iff --workdir/SUPABASE_WORKDIR was set verbatim. */
  readonly explicitWorkdir?: boolean;
}

function setup(options: SetupOptions = {}) {
  const out = mockOutput({
    format: options.format ?? "text",
    promptConfirmResponses: options.promptConfirmResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const workdir = options.workdir ?? tempRoot.current;
  const cliSettings = mockCommandSettings({
    workdir,
    explicitWorkdir: options.explicitWorkdir ?? false,
  });
  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    telemetry.layer,
    cliSettings,
    mockTty({
      stdinIsTty: options.stdinIsTty ?? false,
      stdoutIsTty: options.stdoutIsTty ?? false,
    }),
    mockStdin(options.stdinIsTty ?? false, options.stdinInput),
    Layer.succeed(YesFlag, options.yes ?? false),
    Layer.succeed(CliArgs, { args: [] }),
  );
  return { layer, out, telemetry, workdir };
}

function exitError(exit: Exit.Exit<unknown, unknown>): unknown {
  return Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
}

describe("functions new integration", () => {
  it.effect("creates the default apikey scaffold, config snippet, and optional files", () => {
    const { layer, out, telemetry, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "hello-world", auth: "apikey" });

      const functionDir = path.join(workdir, "supabase", "functions", "hello-world");
      const entrypoint = yield* fs.readFileString(path.join(functionDir, "index.ts"));
      const config = yield* fs.readFileString(path.join(workdir, "supabase", "config.toml"));

      expect(entrypoint).toContain('withSupabase({ auth: ["publishable", "secret"] }');
      expect(entrypoint).toContain("--header 'apiKey: sb_publishable_");
      expect(entrypoint).toContain("http://127.0.0.1:54321/functions/v1/hello-world");
      expect(config).toContain("[functions.hello-world]");
      expect(config).toContain("verify_jwt = false");
      expect(config).toContain('import_map = "./functions/hello-world/deno.json"');
      expect(yield* fs.readFileString(path.join(functionDir, "deno.json"))).toBe(
        FUNCTIONS_NEW_DENO_JSON,
      );
      expect(yield* fs.readFileString(path.join(functionDir, ".npmrc"))).toBe(FUNCTIONS_NEW_NPMRC);
      expect(out.stdoutText).toContain("Created new Function at ");
      expect(out.stdoutText).toContain(path.join("supabase", "functions", "hello-world"));
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n]");
      expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the none-auth scaffold and keeps verify_jwt disabled", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "public-fn", auth: "none" });
      const entrypoint = yield* fs.readFileString(
        path.join(workdir, "supabase", "functions", "public-fn", "index.ts"),
      );
      const config = yield* fs.readFileString(path.join(workdir, "supabase", "config.toml"));
      expect(entrypoint).toContain('withSupabase({ auth: "none" }');
      expect(entrypoint).toContain("--header 'Content-Type: application/json'");
      expect(config).toContain("verify_jwt = false");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the user-auth scaffold and enables verify_jwt", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "user-fn", auth: "user" });
      const entrypoint = yield* fs.readFileString(
        path.join(workdir, "supabase", "functions", "user-fn", "index.ts"),
      );
      const config = yield* fs.readFileString(path.join(workdir, "supabase", "config.toml"));
      expect(entrypoint).toContain('withSupabase({ auth: "user" }');
      expect(entrypoint).toContain("--header 'Authorization: Bearer <UserToken>'");
      expect(config).toContain("verify_jwt = true");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses api.port and auth.publishable_key from config.toml when present", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "config.toml"),
        [
          'project_id = "test-project"',
          "",
          "[api]",
          "port = 54310",
          "",
          "[auth]",
          'publishable_key = "sb_publishable_custom"',
          "",
        ].join("\n"),
      );

      yield* functionsNew({ functionName: "customized", auth: "apikey" });
      const entrypoint = yield* fs.readFileString(
        path.join(workdir, "supabase", "functions", "customized", "index.ts"),
      );
      expect(entrypoint).toContain("http://127.0.0.1:54310/functions/v1/customized");
      expect(entrypoint).toContain("--header 'apiKey: sb_publishable_custom'");
    }).pipe(Effect.provide(layer));
  });

  it.effect("appends config even when the existing config.toml is malformed", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), "not valid toml ][");

      yield* functionsNew({ functionName: "after-bad-config", auth: "none" });
      const config = yield* fs.readFileString(path.join(workdir, "supabase", "config.toml"));
      expect(config).toContain("not valid toml ][");
      expect(config).toContain("[functions.after-bad-config]");
    }).pipe(Effect.provide(layer));
  });

  it.effect("warns and skips the config append when the function is already declared", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "config.toml"),
        ["[functions.hello-world]", "enabled = true", ""].join("\n"),
      );

      yield* functionsNew({ functionName: "hello-world", auth: "apikey" });
      const config = yield* fs.readFileString(path.join(workdir, "supabase", "config.toml"));
      expect(config.match(/\[functions\.hello-world\]/g) ?? []).toHaveLength(1);
      expect(out.stderrText).toContain("[functions.hello-world] is already declared in ");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not auto-generate IDE files when another function already exists", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const existingDir = path.join(workdir, "supabase", "functions", "existing");
      yield* fs.makeDirectory(existingDir, { recursive: true });
      yield* fs.writeFileString(path.join(existingDir, "index.ts"), "// existing\n");

      yield* functionsNew({ functionName: "second-fn", auth: "apikey" });
      expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(yield* fs.exists(path.join(workdir, ".idea", "deno.xml"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("supports --yes by echoing the VS Code prompt and generating settings", () => {
    const { layer, out, workdir } = setup({ yes: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "with-yes", auth: "apikey" });
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y");
      expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "SUPABASE_YES=1 in the environment echoes the VS Code prompt and writes settings",
    () => {
      const { layer, out, workdir } = setup({ yes: false });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* functionsNew({ functionName: "with-env-yes", auth: "apikey" });
        expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y");
        expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(true);
      }).pipe(Effect.provide(layer), (body) => withEnvVar("SUPABASE_YES", "1", body));
    },
  );

  it.effect("piped `n` then `y` declines VS Code and writes IntelliJ settings (Go parity)", () => {
    // Scans one piped line per question, so "n\ny\n" answers VS Code=no,
    // IntelliJ=yes.
    const { layer, out, workdir } = setup({ stdinIsTty: false, stdinInput: "n\ny\n" });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "piped-idea", auth: "apikey" });
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] n");
      expect(out.stderrText).toContain("Generate IntelliJ IDEA settings for Deno? [y/N] y");
      expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(yield* fs.exists(path.join(workdir, ".idea", "deno.xml"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes IntelliJ settings when VS Code is declined and IntelliJ is accepted", () => {
    const { layer, out, workdir } = setup({
      stdinIsTty: true,
      stdoutIsTty: true,
      promptConfirmResponses: [false, true],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "idea-fn", auth: "apikey" });
      expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(yield* fs.exists(path.join(workdir, ".idea", "deno.xml"))).toBe(true);
      expect(out.stdoutText).toContain("Generated IntelliJ settings in .idea/deno.xml.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays payload-only in json mode without writing IDE files", () => {
    const { layer, out, workdir } = setup({ format: "json" });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "json-fn", auth: "apikey" });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        path: path.join("supabase", "functions", "json-fn"),
        function_name: "json-fn",
        auth: "apikey",
      });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).not.toContain("Generate VS Code settings");
      expect(yield* fs.exists(path.join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(yield* fs.exists(path.join(workdir, ".idea", "deno.xml"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits structured success in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* functionsNew({ functionName: "stream-fn", auth: "user" });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        path: path.join("supabase", "functions", "stream-fn"),
        auth: "user",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails on invalid function slugs", () => {
    const { layer, telemetry } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(functionsNew({ functionName: "@", auth: "none" }));
      expect(exitError(exit)).toBeInstanceOf(FunctionsNewInvalidSlugError);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the entrypoint already exists", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dupeDir = path.join(workdir, "supabase", "functions", "dupe");
      yield* fs.makeDirectory(dupeDir, { recursive: true });
      yield* fs.writeFileString(path.join(dupeDir, "index.ts"), "// existing\n");
      const exit = yield* Effect.exit(functionsNew({ functionName: "dupe", auth: "apikey" }));
      expect(exitError(exit)).toBeInstanceOf(FunctionsNewFileExistsError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a write error when config.toml cannot be appended", () => {
    const { layer, telemetry, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A directory at the config.toml path makes the append write fail (EISDIR).
      yield* fs.makeDirectory(path.join(workdir, "supabase", "config.toml"), { recursive: true });
      const exit = yield* Effect.exit(functionsNew({ functionName: "write-fail", auth: "apikey" }));
      expect(exitError(exit)).toBeInstanceOf(FunctionsNewWriteError);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fails without scaffolding anything when --workdir names a directory that does not exist at all",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const badWorkdir = path.join(tempRoot.current, "does-not-exist");
        const { layer, telemetry } = setup({ workdir: badWorkdir, explicitWorkdir: true });
        const exit = yield* Effect.exit(
          functionsNew({ functionName: "hello-world", auth: "apikey" }),
        ).pipe(Effect.provide(layer));
        expect(exitError(exit)).toBeInstanceOf(FunctionsNewWorkdirError);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("failed to change workdir: chdir");
        }
        expect(yield* fs.exists(path.join(badWorkdir, "supabase"))).toBe(false);
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
