import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
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

  it.live("selects function, config, default env, and explicit env watch paths", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      const paths = yield* functionsDevWatchPaths(Option.some("./custom.env"));

      expect(paths).toEqual([
        join(cwd, "supabase", "functions"),
        join(cwd, "supabase", "config.toml"),
        join(cwd, "supabase", "functions", ".env"),
        join(cwd, "custom.env"),
      ]);
    }).pipe(Effect.provide(projectLayer(cwd)));
  });
});
