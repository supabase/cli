import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { functionsDevWatchPaths, resolveFunctionsBundle } from "./functions-dev-config.ts";
import {
  FunctionsDevEdgeRuntimeDisabledError,
  resolveFunctionsDevEdgeRuntimeConfig,
} from "./functions-dev-edge-runtime-config.ts";
import { connectOrStartFunctionsDevStack } from "./functions-dev-runtime.ts";

function projectLayer(cwd: string, path: Path.Path, env: Readonly<Record<string, string>> = {}) {
  const projectHomeDir = path.join(cwd, ".supabase");
  return Layer.mergeAll(
    BunServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env, preserveEmptyStrings: true })),
    Layer.succeed(
      RuntimeInfo,
      RuntimeInfo.of({
        cwd,
        platform: process.platform,
        arch: process.arch,
        homeDir: path.join(cwd, ".home"),
        execPath: process.execPath,
        pid: process.pid,
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

function withTempProject<A, E, R>(
  body: (cwd: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-functions-dev-" });
      return yield* body(cwd, fs, path);
    }),
  );
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("functions dev config", () => {
  it("exports the start-or-connect block for future dev orchestration", () => {
    expect(connectOrStartFunctionsDevStack).toBeTypeOf("function");
  });

  it.live("resolves project functions, environment and absolute paths before stack handoff", () => {
    return withTempProject((cwd, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(cwd, "supabase", "functions", "hello", "assets"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "functions", "hello", "index.ts"),
          "export {};\n",
        );
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "functions", "hello", "deno.json"),
          "{}\n",
        );
        yield* fs.writeFileString(
          path.join(cwd, "supabase", ".env"),
          "FUNCTION_VALUE=resolved-secret\n",
        );
        yield* fs.writeFileString(path.join(cwd, "custom.env"), "SHARED=custom\n");
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          `[functions.hello]
verify_jwt = true
entrypoint = "./functions/hello/index.ts"
import_map = "./functions/hello/deno.json"
static_files = ["./functions/hello/assets/*"]

[functions.hello.env]
FUNCTION_VALUE = "env(FUNCTION_VALUE)"
`,
        );

        const bundle = yield* resolveFunctionsBundle({
          envFile: Option.some("./custom.env"),
          noVerifyJwt: true,
        });

        expect(bundle).toEqual({
          env: { SHARED: "custom" },
          functions: [
            {
              name: "hello",
              verifyJWT: false,
              entrypointPath: path.join(cwd, "supabase", "functions", "hello", "index.ts"),
              importMapPath: path.join(cwd, "supabase", "functions", "hello", "deno.json"),
              staticFiles: [path.join(cwd, "supabase", "functions", "hello", "assets", "*")],
              env: { FUNCTION_VALUE: "resolved-secret" },
            },
          ],
        });
      }).pipe(Effect.provide(projectLayer(cwd, path))),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("resolves function paths from the injected shell environment", () => {
    return withTempProject((cwd, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(cwd, "supabase", "functions", "hello"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "functions", "hello", "index.ts"),
          "export {};\n",
        );
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          `[functions.hello]
verify_jwt = true
entrypoint = "env(FUNCTION_ENTRYPOINT)"
`,
        );

        const bundle = yield* resolveFunctionsBundle({
          envFile: Option.none(),
          noVerifyJwt: false,
        });

        expect(bundle.functions[0]?.entrypointPath).toBe(
          path.join(cwd, "supabase", "functions", "hello", "index.ts"),
        );
      }).pipe(
        Effect.provide(
          projectLayer(cwd, path, {
            FUNCTION_ENTRYPOINT: "./functions/hello/index.ts",
          }),
        ),
      ),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("selects supabase and explicit env directory watch paths", () => {
    return withTempProject((cwd, _fs, path) =>
      Effect.gen(function* () {
        const paths = yield* functionsDevWatchPaths(Option.some("./custom.env"));

        expect(paths).toEqual([
          { path: path.join(cwd, "supabase"), names: ["functions", "config.toml", "config.json"] },
          { path: cwd, names: ["custom.env"] },
        ]);
      }).pipe(Effect.provide(projectLayer(cwd, path))),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("resolves edge runtime config from project config and secrets", () => {
    return withTempProject((cwd, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, "supabase", ".env"), "EDGE_API_KEY=edge-secret\n");
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          `project_id = "test"

[edge_runtime]
policy = "oneshot"
inspector_port = 8123

[edge_runtime.secrets]
api_key = "env(EDGE_API_KEY)"
literal = "literal-secret"
`,
        );

        const result = yield* resolveFunctionsDevEdgeRuntimeConfig();

        expect(result.config).toEqual({
          enabled: true,
          inspectorPort: 8123,
          policy: "oneshot",
          env: {
            API_KEY: "edge-secret",
            LITERAL: "literal-secret",
          },
        });
      }).pipe(Effect.provide(projectLayer(cwd, path))),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "resolves edge runtime numeric and boolean fields from the injected shell environment",
    () => {
      return withTempProject((cwd, fs, path) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            path.join(cwd, "supabase", "config.toml"),
            `[edge_runtime]
enabled = "env(EDGE_RUNTIME_ENABLED)"
inspector_port = "env(EDGE_RUNTIME_INSPECTOR_PORT)"
policy = "oneshot"
`,
          );

          const result = yield* resolveFunctionsDevEdgeRuntimeConfig();

          expect(result.config).toEqual({
            enabled: true,
            inspectorPort: 8123,
            policy: "oneshot",
            env: {},
          });
        }).pipe(
          Effect.provide(
            projectLayer(cwd, path, {
              EDGE_RUNTIME_ENABLED: "true",
              EDGE_RUNTIME_INSPECTOR_PORT: "8123",
            }),
          ),
        ),
      ).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.live("fails when edge runtime is disabled for functions dev", () => {
    return withTempProject((cwd, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.json"),
          encodeJson({ edge_runtime: { enabled: false } }),
        );

        const error = yield* resolveFunctionsDevEdgeRuntimeConfig().pipe(Effect.flip);

        expect(error).toBeInstanceOf(FunctionsDevEdgeRuntimeDisabledError);
      }).pipe(Effect.provide(projectLayer(cwd, path))),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("does not resolve a lowercase-named env() reference in edge runtime secrets", () => {
    return withTempProject((cwd, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(cwd, "supabase", ".env"),
          "lowercase_env_var=should-not-resolve\n",
        );
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          `project_id = "test"

[edge_runtime]
policy = "oneshot"
inspector_port = 8123

[edge_runtime.secrets]
lowercase_secret = "env(lowercase_env_var)"
`,
        );

        const result = yield* resolveFunctionsDevEdgeRuntimeConfig();

        expect(result.config).toEqual({
          enabled: true,
          inspectorPort: 8123,
          policy: "oneshot",
          env: {
            LOWERCASE_SECRET: "env(lowercase_env_var)",
          },
        });
      }).pipe(Effect.provide(projectLayer(cwd, path))),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("does not split a comma-separated string literal for an array field", () => {
    return withTempProject((cwd, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, "supabase", ".env"), "EDGE_API_KEY=edge-secret\n");
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          `project_id = "test"

[auth]
additional_redirect_urls = "http://a,http://b"

[edge_runtime]
policy = "oneshot"
inspector_port = 8123

[edge_runtime.secrets]
api_key = "env(EDGE_API_KEY)"
literal = "literal-secret"
`,
        );

        const exit = yield* resolveFunctionsDevEdgeRuntimeConfig().pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(projectLayer(cwd, path))),
    ).pipe(Effect.provide(BunServices.layer));
  });
});
