import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option, Stdio } from "effect";
import { Command } from "effect/unstable/cli";
import {
  mockAnalytics,
  mockCredentials,
  mockOutput,
  mockProcessControl,
  mockProjectLinkState,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { functionsCommand } from "../functions.command.ts";
import { functionsNew } from "./new.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-new-"));
}

function buildLayer(cwd: string) {
  const out = mockOutput({ format: "text", interactive: false });

  return {
    out,
    layer: Layer.mergeAll(out.layer, mockRuntimeInfo({ cwd }), BunServices.layer),
  };
}

function cliConfigLayer() {
  return Layer.succeed(
    CliConfig,
    CliConfig.of({
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://us.i.posthog.com",
      telemetryPosthogKey: "phc_test_key",
      accessToken: Option.none(),
      noKeyring: Option.none(),
      supabaseHome: "/tmp/supabase-cli-test-home",
      debug: Option.none(),
      telemetryDebug: Option.none(),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    }),
  );
}

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect((failure.value as { _tag: string })._tag).toBe(tag);
    }
  }
}

describe("functions new", () => {
  it.live("creates function files without creating config in an uninitialized project", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer, out } = buildLayer(tempDir);

      yield* functionsNew(Option.some("hello-world")).pipe(Effect.provide(layer));

      expect(existsSync(join(tempDir, "supabase", "config.json"))).toBe(false);
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe(`Deno.serve(async (req) => {
  const { name } = await req.json();
  return Response.json({ message: \`Hello \${name}!\` });
});
`);
      expect(
        JSON.parse(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "deno.json"), "utf8"),
          ),
        ),
      ).toEqual({
        imports: {
          "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
        },
      });
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Created Edge Function." }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("leaves existing config.json untouched", () => {
    const tempDir = makeTempDir();
    const configPath = join(tempDir, "supabase", "config.json");
    const configContent = `${JSON.stringify(
      {
        $schema: "./node_modules/@supabase/config/schema.json",
        db: { major_version: 16 },
        functions: {
          existing: {
            entrypoint: "./functions/existing/index.ts",
          },
        },
      },
      null,
      2,
    )}\n`;

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(configPath, configContent));
      const { layer } = buildLayer(tempDir);

      yield* functionsNew(Option.some("hello-world")).pipe(Effect.provide(layer));

      expect(yield* Effect.tryPromise(() => readFile(configPath, "utf8"))).toBe(configContent);
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toContain("Deno.serve");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("leaves existing config.toml untouched", () => {
    const tempDir = makeTempDir();
    const configPath = join(tempDir, "supabase", "config.toml");
    const configContent = 'project_id = "local-ref"\n';

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(configPath, configContent));
      const { layer } = buildLayer(tempDir);

      yield* functionsNew(Option.some("hello-world")).pipe(Effect.provide(layer));

      const config = yield* Effect.tryPromise(() => readFile(configPath, "utf8"));
      expect(config).toBe(configContent);
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toContain("Deno.serve");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when the function entrypoint already exists", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const functionDir = join(tempDir, "supabase", "functions", "hello-world");
      yield* Effect.tryPromise(() => mkdir(functionDir, { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(join(functionDir, "index.ts"), "// existing\n"));
      const { layer } = buildLayer(tempDir);

      const exit = yield* functionsNew(Option.some("hello-world")).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expectFailureTag(exit, "FunctionEntrypointExistsError");
      expect(yield* Effect.tryPromise(() => readFile(join(functionDir, "index.ts"), "utf8"))).toBe(
        "// existing\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects invalid slugs", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer } = buildLayer(tempDir);

      const exit = yield* functionsNew(Option.some("hello/world")).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expectFailureTag(exit, "InvalidFunctionSlugError");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prompts for a function slug when interactive text output has no argument", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const out = mockOutput({
        format: "text",
        interactive: true,
        promptTextResponses: ["hello-world"],
      });
      const layer = Layer.mergeAll(out.layer, mockRuntimeInfo({ cwd: tempDir }), BunServices.layer);

      yield* functionsNew(Option.none()).pipe(Effect.provide(layer));

      expect(existsSync(join(tempDir, "supabase", "config.json"))).toBe(false);
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toContain("Deno.serve");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails without a function slug in non-interactive mode", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer } = buildLayer(tempDir);

      const exit = yield* functionsNew(Option.none()).pipe(Effect.provide(layer), Effect.exit);

      expectFailureTag(exit, "MissingFunctionSlugError");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("registers the command under functions new", () => {
    const tempDir = makeTempDir();
    const out = mockOutput({ format: "text", interactive: false });
    const analytics = mockAnalytics();
    const processControl = mockProcessControl();
    const layer = Layer.mergeAll(
      out.layer,
      analytics.layer,
      processControl.layer,
      mockRuntimeInfo({ cwd: tempDir }),
      BunServices.layer,
      cliConfigLayer(),
      mockProjectLinkState(),
      mockCredentials().layer,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "new", "hello-world"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Command.runWith(functionsCommand, { version: "0.1.0" })(["new", "hello-world"]).pipe(
        Effect.provide(layer),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Created Edge Function." }),
      );
      expect(analytics.captured).toContainEqual(
        expect.objectContaining({
          event: "cli_command_executed",
          properties: expect.objectContaining({ exit_code: 0 }),
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
