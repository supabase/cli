import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { StateManager } from "@supabase/stack/effect";
import { ProjectLinkState } from "./project-link-state.service.ts";
import { ProjectLocalServiceVersions } from "./project-local-service-versions.service.ts";
import { projectCommandBaseLayer, provideProjectCommandRuntime } from "./project-runtime.layer.ts";
import { projectLinkStateLayer } from "./project-link-state.layer.ts";
import { projectLocalServiceVersionsLayer } from "./project-local-service-versions.layer.ts";
import { ProjectHome } from "./project-home.service.ts";
import { projectStackStateManagerLayer } from "./project-stack-state-manager.layer.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-runtime-"));
}

describe("project-runtime.layer", () => {
  it.live("builds the shared project runtime for config-discovered checkouts", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const previousCwd = process.cwd();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
      );
      yield* Effect.sync(() => process.chdir(projectRoot));

      const projectHome = yield* Effect.gen(function* () {
        return yield* ProjectHome;
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, projectCommandBaseLayer)));
      const resolvedProjectRoot = yield* Effect.tryPromise(() => realpath(projectRoot));
      expect(projectHome.projectRoot).toBe(resolvedProjectRoot);
      expect(projectHome.projectHomeDir).toBe(join(resolvedProjectRoot, ".supabase"));
    }).pipe(
      Effect.ensuring(Effect.sync(() => process.chdir(previousCwd))),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("provides repo-local stack services through the shared runtime helper", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const previousCwd = process.cwd();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
      );
      yield* Effect.sync(() => process.chdir(projectRoot));

      const layer = Layer.mergeAll(
        BunServices.layer,
        provideProjectCommandRuntime(
          Layer.mergeAll(
            projectLinkStateLayer,
            projectLocalServiceVersionsLayer,
            projectStackStateManagerLayer,
          ),
        ),
      );

      const services = yield* Effect.gen(function* () {
        return {
          projectLinkState: yield* ProjectLinkState,
          projectLocalServiceVersions: yield* ProjectLocalServiceVersions,
          stateManager: yield* StateManager,
        };
      }).pipe(Effect.provide(layer));

      expect(services.projectLinkState).toBeDefined();
      expect(services.projectLocalServiceVersions).toBeDefined();
      expect(services.stateManager).toBeDefined();
    }).pipe(
      Effect.ensuring(Effect.sync(() => process.chdir(previousCwd))),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
