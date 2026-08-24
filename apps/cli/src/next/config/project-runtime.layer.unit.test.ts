import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { projectCommandBaseLayer } from "./project-runtime.layer.ts";
import { ProjectHome } from "./project-home.service.ts";

describe("project-runtime.layer", () => {
  it.live("builds the shared project runtime for config-discovered checkouts", () => {
    const previousCwd = process.cwd();

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-runtime-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectRoot, "supabase", "config.toml"),
          'project_id = "repo"\n',
        );
        yield* Effect.sync(() => process.chdir(projectRoot));

        const projectHome = yield* ProjectHome.pipe(
          Effect.provide(Layer.mergeAll(BunServices.layer, projectCommandBaseLayer)),
        );
        const resolvedProjectRoot = yield* fs.realPath(projectRoot);
        expect(projectHome.projectRoot).toBe(resolvedProjectRoot);
        expect(projectHome.projectHomeDir).toBe(path.join(resolvedProjectRoot, ".supabase"));
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(
      Effect.ensuring(Effect.sync(() => process.chdir(previousCwd))),
      Effect.provide(BunServices.layer),
    );
  });
});
