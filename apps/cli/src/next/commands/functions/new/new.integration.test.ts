import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { httpTransportClientLayer } from "@supabase/stack/effect";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stdio,
} from "effect";
import { Command } from "effect/unstable/cli";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import {
  mockAnalytics,
  mockCredentials,
  mockOutput,
  mockProcessControl,
  mockProjectContext,
  mockProjectLinkState,
  mockRuntimeInfo,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import { functionsCommand } from "../functions.command.ts";
import { functionsNew } from "./new.handler.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { makeLegacyViperEnvLayer } from "../../../../shared/legacy/legacy-viper-env.ts";

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "supabase-functions-new-" });
});

const removeTempDir = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { recursive: true }).pipe(Effect.ignore);
  });

function buildLayer(cwd: string) {
  const out = mockOutput({ format: "text", interactive: false });

  return {
    out,
    layer: Layer.mergeAll(out.layer, mockRuntimeInfo({ cwd }), BunServices.layer),
  };
}

function commandTreeSupportLayer(cwd: string, path: Path.Path) {
  const projectHomeDir = path.join(cwd, ".supabase");
  return Layer.mergeAll(
    httpTransportClientLayer,
    Layer.succeed(
      CliConfig,
      CliConfig.of({
        apiUrl: "https://api.supabase.com",
        dashboardUrl: "https://supabase.com/dashboard",
        projectHost: "supabase.co",
        telemetryPosthogHost: "https://us.i.posthog.com",
        telemetryPosthogKey: Option.some("phc_test_key"),
        accessToken: Option.none(),
        noKeyring: Option.none(),
        supabaseHome: path.join(cwd, ".cache", "supabase"),
        debug: Option.none(),
        telemetryDebug: Option.none(),
        telemetryDisabled: Option.none(),
        doNotTrack: Option.none(),
      }),
    ),
    Layer.succeed(
      ProjectHome,
      ProjectHome.of({
        projectRoot: cwd,
        supabaseDir: path.join(cwd, "supabase"),
        projectHomeDir,
        projectLinkPath: path.join(projectHomeDir, "project.json"),
        projectLocalVersionsPath: path.join(projectHomeDir, "local-versions.json"),
        ensureProjectHomeDir: Effect.void,
      }),
    ),
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
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { layer, out } = buildLayer(tempDir);

          yield* functionsNew(Option.some("hello-world")).pipe(Effect.provide(layer));

          expect(yield* fs.exists(path.join(tempDir, "supabase", "config.json"))).toBe(false);
          expect(
            yield* fs.readFileString(
              path.join(tempDir, "supabase", "functions", "hello-world", "index.ts"),
            ),
          ).toBe(`Deno.serve(async (req) => {
  const { name } = await req.json();
  return Response.json({ message: \`Hello \${name}!\` });
});
`);
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              yield* fs.readFileString(
                path.join(tempDir, "supabase", "functions", "hello-world", "deno.json"),
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
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("leaves existing config.json untouched", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configPath = path.join(tempDir, "supabase", "config.json");
          const configContent =
            '{\n  "$schema": "./node_modules/@supabase/config/schema.json",\n  "db": {\n    "major_version": 16\n  },\n  "functions": {\n    "existing": {\n      "entrypoint": "./functions/existing/index.ts"\n    }\n  }\n}\n';

          yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
          yield* fs.writeFileString(configPath, configContent);
          const { layer } = buildLayer(tempDir);

          yield* functionsNew(Option.some("hello-world")).pipe(Effect.provide(layer));

          expect(yield* fs.readFileString(configPath)).toBe(configContent);
          expect(
            yield* fs.readFileString(
              path.join(tempDir, "supabase", "functions", "hello-world", "index.ts"),
            ),
          ).toContain("Deno.serve");
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("leaves existing config.toml untouched", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configPath = path.join(tempDir, "supabase", "config.toml");
          const configContent = 'project_id = "local-ref"\n';

          yield* fs.makeDirectory(path.join(tempDir, "supabase"), { recursive: true });
          yield* fs.writeFileString(configPath, configContent);
          const { layer } = buildLayer(tempDir);

          yield* functionsNew(Option.some("hello-world")).pipe(Effect.provide(layer));

          expect(yield* fs.readFileString(configPath)).toBe(configContent);
          expect(
            yield* fs.readFileString(
              path.join(tempDir, "supabase", "functions", "hello-world", "index.ts"),
            ),
          ).toContain("Deno.serve");
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails when the function entrypoint already exists", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const functionDir = path.join(tempDir, "supabase", "functions", "hello-world");
          yield* fs.makeDirectory(functionDir, { recursive: true });
          yield* fs.writeFileString(path.join(functionDir, "index.ts"), "// existing\n");
          const { layer } = buildLayer(tempDir);

          const exit = yield* functionsNew(Option.some("hello-world")).pipe(
            Effect.provide(layer),
            Effect.exit,
          );

          expectFailureTag(exit, "FunctionEntrypointExistsError");
          expect(yield* fs.readFileString(path.join(functionDir, "index.ts"))).toBe(
            "// existing\n",
          );
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("rejects invalid slugs", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const { layer } = buildLayer(tempDir);

          const exit = yield* functionsNew(Option.some("hello/world")).pipe(
            Effect.provide(layer),
            Effect.exit,
          );

          expectFailureTag(exit, "InvalidFunctionSlugError");
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("prompts for a function slug when interactive text output has no argument", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const out = mockOutput({
            format: "text",
            interactive: true,
            promptTextResponses: ["hello-world"],
          });
          const layer = Layer.mergeAll(
            out.layer,
            mockRuntimeInfo({ cwd: tempDir }),
            BunServices.layer,
          );

          yield* functionsNew(Option.none()).pipe(Effect.provide(layer));

          expect(yield* fs.exists(path.join(tempDir, "supabase", "config.json"))).toBe(false);
          expect(
            yield* fs.readFileString(
              path.join(tempDir, "supabase", "functions", "hello-world", "index.ts"),
            ),
          ).toContain("Deno.serve");
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails without a function slug in non-interactive mode", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const { layer } = buildLayer(tempDir);

          const exit = yield* functionsNew(Option.none()).pipe(Effect.provide(layer), Effect.exit);

          expectFailureTag(exit, "MissingFunctionSlugError");
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("registers the command under functions new", () => {
    return Effect.acquireUseRelease(
      makeTempDir,
      (tempDir) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const out = mockOutput({ format: "text", interactive: false });
          const analytics = mockAnalytics();
          const processControl = mockProcessControl();
          const layer = Layer.mergeAll(
            out.layer,
            analytics.layer,
            processControl.layer,
            mockRuntimeInfo({ cwd: tempDir }),
            mockTty({ stdinIsTty: false, stdoutIsTty: false }),
            commandRuntimeLayer(["functions"]).pipe(Layer.provide(BunServices.layer)),
            commandTreeSupportLayer(tempDir, path),
            makeLegacyViperEnvLayer(
              ConfigProvider.fromEnv({ env: {}, preserveEmptyStrings: true }),
            ),
            mockProjectContext(),
            mockProjectLinkState(),
            mockCredentials().layer,
            Stdio.layerTest({
              args: Effect.succeed(["functions", "new", "hello-world"]),
            }),
          );

          yield* Command.runWith(functionsCommand, { version: "0.1.0" })([
            "new",
            "hello-world",
          ]).pipe(Effect.provide(layer));

          expect(out.messages).toContainEqual(
            expect.objectContaining({ type: "success", message: "Created Edge Function." }),
          );
          expect(analytics.captured).toContainEqual(
            expect.objectContaining({
              event: "cli_command_executed",
              properties: expect.objectContaining({ exit_code: 0 }),
            }),
          );
        }),
      removeTempDir,
    ).pipe(Effect.provide(BunServices.layer));
  });
});
