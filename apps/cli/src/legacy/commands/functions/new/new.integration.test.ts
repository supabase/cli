import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";

import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyFunctionsNew } from "./new.handler.ts";
import { LEGACY_FUNCTIONS_NEW_DENO_JSON, LEGACY_FUNCTIONS_NEW_NPMRC } from "./new.templates.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-new-int-");

interface SetupOptions {
  readonly format?: "text" | "json" | "stream-json";
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly yes?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
}

function setup(options: SetupOptions = {}) {
  const out = mockOutput({
    format: options.format ?? "text",
    promptConfirmResponses: options.promptConfirmResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    telemetry.layer,
    cliConfig,
    mockTty({
      stdinIsTty: options.stdinIsTty ?? false,
      stdoutIsTty: options.stdoutIsTty ?? false,
    }),
    Layer.succeed(LegacyYesFlag, options.yes ?? false),
  );
  return { layer, out, telemetry, workdir: tempRoot.current };
}

function exitTag(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (!Exit.isFailure(exit)) {
    return undefined;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some") {
    return undefined;
  }
  if (typeof failure.value !== "object" || failure.value === null || !("_tag" in failure.value)) {
    return undefined;
  }
  return String(failure.value._tag);
}

describe("legacy functions new integration", () => {
  it.live("creates the default apikey scaffold, config snippet, and optional files", () => {
    const { layer, out, telemetry, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "hello-world", auth: "apikey" });

      const functionDir = join(workdir, "supabase", "functions", "hello-world");
      const entrypoint = yield* Effect.tryPromise(() =>
        readFile(join(functionDir, "index.ts"), "utf8"),
      );
      const config = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "config.toml"), "utf8"),
      );

      expect(entrypoint).toContain('withSupabase({ auth: ["publishable", "secret"] }');
      expect(entrypoint).toContain("--header 'apiKey: sb_publishable_");
      expect(entrypoint).toContain("http://127.0.0.1:54321/functions/v1/hello-world");
      expect(config).toContain("[functions.hello-world]");
      expect(config).toContain("verify_jwt = false");
      expect(config).toContain('import_map = "./functions/hello-world/deno.json"');
      expect(readFileSync(join(functionDir, "deno.json"), "utf8")).toBe(
        LEGACY_FUNCTIONS_NEW_DENO_JSON,
      );
      expect(readFileSync(join(functionDir, ".npmrc"), "utf8")).toBe(LEGACY_FUNCTIONS_NEW_NPMRC);
      expect(out.stdoutText).toContain("Created new Function at ");
      expect(out.stdoutText).toContain(join("supabase", "functions", "hello-world"));
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n]");
      expect(existsSync(join(workdir, ".vscode", "settings.json"))).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses the none-auth scaffold and keeps verify_jwt disabled", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "public-fn", auth: "none" });
      const entrypoint = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "functions", "public-fn", "index.ts"), "utf8"),
      );
      const config = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "config.toml"), "utf8"),
      );
      expect(entrypoint).toContain('withSupabase({ auth: "none" }');
      expect(entrypoint).toContain("--header 'Content-Type: application/json'");
      expect(config).toContain("verify_jwt = false");
    }).pipe(Effect.provide(layer));
  });

  it.live("uses the user-auth scaffold and enables verify_jwt", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "user-fn", auth: "user" });
      const entrypoint = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "functions", "user-fn", "index.ts"), "utf8"),
      );
      const config = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "config.toml"), "utf8"),
      );
      expect(entrypoint).toContain('withSupabase({ auth: "user" }');
      expect(entrypoint).toContain("--header 'Authorization: Bearer <UserToken>'");
      expect(config).toContain("verify_jwt = true");
    }).pipe(Effect.provide(layer));
  });

  it.live("uses api.port and auth.publishable_key from config.toml when present", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(workdir, "supabase"), { recursive: true }).then(() =>
          writeFile(
            join(workdir, "supabase", "config.toml"),
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
          ),
        ),
      );

      yield* legacyFunctionsNew({ functionName: "customized", auth: "apikey" });
      const entrypoint = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "functions", "customized", "index.ts"), "utf8"),
      );
      expect(entrypoint).toContain("http://127.0.0.1:54310/functions/v1/customized");
      expect(entrypoint).toContain("--header 'apiKey: sb_publishable_custom'");
    }).pipe(Effect.provide(layer));
  });

  it.live("appends config even when the existing config.toml is malformed", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(workdir, "supabase"), { recursive: true }).then(() =>
          writeFile(join(workdir, "supabase", "config.toml"), "not valid toml ]["),
        ),
      );

      yield* legacyFunctionsNew({ functionName: "after-bad-config", auth: "none" });
      const config = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "config.toml"), "utf8"),
      );
      expect(config).toContain("not valid toml ][");
      expect(config).toContain("[functions.after-bad-config]");
    }).pipe(Effect.provide(layer));
  });

  it.live("warns and skips the config append when the function is already declared", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(workdir, "supabase"), { recursive: true }).then(() =>
          writeFile(
            join(workdir, "supabase", "config.toml"),
            ["[functions.hello-world]", "enabled = true", ""].join("\n"),
          ),
        ),
      );

      yield* legacyFunctionsNew({ functionName: "hello-world", auth: "apikey" });
      const config = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "config.toml"), "utf8"),
      );
      expect(config.match(/\[functions\.hello-world\]/g) ?? []).toHaveLength(1);
      expect(out.stderrText).toContain("[functions.hello-world] is already declared in ");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not auto-generate IDE files when another function already exists", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(workdir, "supabase", "functions", "existing"), { recursive: true }).then(() =>
          writeFile(
            join(workdir, "supabase", "functions", "existing", "index.ts"),
            "// existing\n",
          ),
        ),
      );

      yield* legacyFunctionsNew({ functionName: "second-fn", auth: "apikey" });
      expect(existsSync(join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(existsSync(join(workdir, ".idea", "deno.xml"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("supports --yes by echoing the VS Code prompt and generating settings", () => {
    const { layer, out, workdir } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "with-yes", auth: "apikey" });
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y");
      expect(existsSync(join(workdir, ".vscode", "settings.json"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes IntelliJ settings when VS Code is declined and IntelliJ is accepted", () => {
    const { layer, out, workdir } = setup({
      stdinIsTty: true,
      stdoutIsTty: true,
      promptConfirmResponses: [false, true],
    });
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "idea-fn", auth: "apikey" });
      expect(existsSync(join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(existsSync(join(workdir, ".idea", "deno.xml"))).toBe(true);
      expect(out.stdoutText).toContain("Generated IntelliJ settings in .idea/deno.xml.");
    }).pipe(Effect.provide(layer));
  });

  it.live("stays payload-only in json mode without writing IDE files", () => {
    const { layer, out, workdir } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "json-fn", auth: "apikey" });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        path: join("supabase", "functions", "json-fn"),
        function_name: "json-fn",
        auth: "apikey",
      });
      expect(out.stdoutText).toBe("");
      // Machine formats are payload-only: the IDE prompt is suppressed and no IDE settings
      // are scaffolded as an undisclosed side effect.
      expect(out.stderrText).not.toContain("Generate VS Code settings");
      expect(existsSync(join(workdir, ".vscode", "settings.json"))).toBe(false);
      expect(existsSync(join(workdir, ".idea", "deno.xml"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits structured success in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyFunctionsNew({ functionName: "stream-fn", auth: "user" });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        path: join("supabase", "functions", "stream-fn"),
        auth: "user",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on invalid function slugs", () => {
    const { layer, telemetry } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyFunctionsNew({ functionName: "@", auth: "none" }));
      expect(exitTag(exit)).toBe("LegacyFunctionsNewInvalidSlugError");
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the entrypoint already exists", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(workdir, "supabase", "functions", "dupe"), { recursive: true }).then(() =>
          writeFile(join(workdir, "supabase", "functions", "dupe", "index.ts"), "// existing\n"),
        ),
      );
      const exit = yield* Effect.exit(legacyFunctionsNew({ functionName: "dupe", auth: "apikey" }));
      expect(exitTag(exit)).toBe("LegacyFunctionsNewFileExistsError");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a write error when config.toml cannot be appended", () => {
    const { layer, telemetry, workdir } = setup();
    return Effect.gen(function* () {
      // A directory at the config.toml path makes the append write fail (EISDIR).
      yield* Effect.tryPromise(() =>
        mkdir(join(workdir, "supabase", "config.toml"), { recursive: true }),
      );
      const exit = yield* Effect.exit(
        legacyFunctionsNew({ functionName: "write-fail", auth: "apikey" }),
      );
      expect(exitTag(exit)).toBe("LegacyFunctionsNewWriteError");
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
