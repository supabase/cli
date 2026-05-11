import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  functionsDevWatchPaths,
  toStackFunctionsConfig,
  type FunctionsDevConfigOptions,
} from "./functions-dev-config.ts";
import {
  FunctionsDevEdgeRuntimeDisabledError,
  resolveFunctionsDevEdgeRuntimeConfig,
} from "./functions-dev-edge-runtime-config.ts";
import { connectOrStartFunctionsDevStack } from "./functions-dev-runtime.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-dev-"));
}

function projectLayer(cwd: string) {
  const projectHomeDir = join(cwd, ".supabase");
  return Layer.mergeAll(
    BunServices.layer,
    Layer.succeed(
      RuntimeInfo,
      RuntimeInfo.of({
        cwd,
        platform: process.platform,
        arch: process.arch,
        homeDir: join(cwd, ".home"),
        execPath: process.execPath,
        pid: process.pid,
      }),
    ),
    Layer.succeed(
      ProjectHome,
      ProjectHome.of({
        projectRoot: cwd,
        supabaseDir: join(cwd, "supabase"),
        projectHomeDir,
        projectLinkPath: join(projectHomeDir, "project.json"),
        projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
        ensureProjectHomeDir: Effect.void,
        stackDir: (name) => join(projectHomeDir, "stacks", name),
        stackStatePath: (name) => join(projectHomeDir, "stacks", name, "state.json"),
        stackMetadataPath: (name) => join(projectHomeDir, "stacks", name, "stack.json"),
        stackDataDir: (name) => join(projectHomeDir, "stacks", name, "data"),
        stackLogsDir: (name) => join(projectHomeDir, "stacks", name, "logs"),
      }),
    ),
  );
}

describe("functions dev config", () => {
  it("exports the start-or-connect block for future dev orchestration", () => {
    expect(connectOrStartFunctionsDevStack).toBeTypeOf("function");
  });

  it("converts CLI options to stack Functions config", () => {
    const opts: FunctionsDevConfigOptions = {
      envFile: Option.some("./custom.env"),
      noVerifyJwt: true,
    };

    expect(toStackFunctionsConfig(opts)).toEqual({
      envFile: "./custom.env",
      noVerifyJwt: true,
    });
  });

  it.live("selects supabase and explicit env directory watch paths", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      const paths = yield* functionsDevWatchPaths(Option.some("./custom.env"));

      expect(paths).toEqual([
        { path: join(cwd, "supabase"), names: ["functions", "config.toml", "config.json"] },
        { path: cwd, names: ["custom.env"] },
      ]);
    }).pipe(Effect.provide(projectLayer(cwd)));
  });

  it.live("resolves edge runtime config from project config and secrets", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(cwd, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(cwd, "supabase", ".env"), "EDGE_API_KEY=edge-secret\n"),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(cwd, "supabase", "config.toml"),
          `project_id = "test"

[edge_runtime]
policy = "oneshot"
inspector_port = 8123

[edge_runtime.secrets]
api_key = "env(EDGE_API_KEY)"
literal = "literal-secret"
`,
        ),
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(cwd, { recursive: true, force: true }))),
      Effect.provide(projectLayer(cwd)),
    );
  });

  it.live("fails when edge runtime is disabled for functions dev", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(cwd, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          join(cwd, "supabase", "config.json"),
          JSON.stringify({ edge_runtime: { enabled: false } }),
        ),
      );

      const error = yield* resolveFunctionsDevEdgeRuntimeConfig().pipe(Effect.flip);

      expect(error).toBeInstanceOf(FunctionsDevEdgeRuntimeDisabledError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(cwd, { recursive: true, force: true }))),
      Effect.provide(projectLayer(cwd)),
    );
  });
});
