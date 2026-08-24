import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, FileSystem, Exit, Layer, Option, Path, Result } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";
import { ProjectContext } from "./project-context.service.ts";
import { ProjectHome, ProjectHomeNotDirectoryError } from "./project-home.service.ts";

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredProjectContextLayer = projectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliConfigLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(envLayer),
  );
  const discoveredProjectHomeLayer = projectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(discoveredCliConfigLayer),
  );

  return Layer.mergeAll(
    discoveredProjectContextLayer,
    discoveredCliConfigLayer,
    discoveredProjectHomeLayer,
  );
}

describe("projectHomeLayer", () => {
  it.live("resolves a repo-local project home from the nearest discovered config root", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-home-" });
      yield* Effect.gen(function* () {
        const repoRoot = path.join(tempDir, "repo");
        const packageRoot = path.join(repoRoot, "apps", "web");
        const cwd = path.join(packageRoot, "src");
        const supabaseHome = path.join(tempDir, "supabase-home");
        yield* fs.makeDirectory(path.join(packageRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.writeFileString(
          path.join(packageRoot, "supabase", "config.toml"),
          'project_id = "web"\n',
        );

        const projectHome = yield* ProjectHome.pipe(
          Effect.provide(
            buildLayer({
              cwd,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: supabaseHome },
            }),
          ),
        );
        const projectContext = yield* ProjectContext.pipe(
          Effect.provide(
            buildLayer({
              cwd,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: supabaseHome },
            }),
          ),
        );

        expect(Option.isSome(projectContext.paths)).toBe(true);
        expect(projectHome.projectRoot).toBe(packageRoot);
        expect(projectHome.supabaseDir).toBe(path.join(packageRoot, "supabase"));
        expect(projectHome.projectHomeDir).toBe(path.join(packageRoot, ".supabase"));
        expect(projectHome.projectLocalVersionsPath).toBe(
          path.join(packageRoot, ".supabase", "local-versions.json"),
        );
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("falls back to the nearest linked project root when no project config exists", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-home-" });
      yield* Effect.gen(function* () {
        const repoRoot = path.join(tempDir, "repo");
        const projectRoot = path.join(repoRoot, "apps", "web");
        const cwd = path.join(projectRoot, "src", "feature");
        yield* fs.makeDirectory(path.join(projectRoot, ".supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(projectRoot, ".supabase", "project.json"), "{}\n");
        yield* fs.makeDirectory(cwd, { recursive: true });

        const projectHome = yield* ProjectHome.pipe(
          Effect.provide(
            buildLayer({
              cwd,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
            }),
          ),
        );

        expect(projectHome.projectRoot).toBe(projectRoot);
        expect(projectHome.projectHomeDir).toBe(path.join(projectRoot, ".supabase"));
        expect(projectHome.supabaseDir).toBe(path.join(projectRoot, "supabase"));
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("does not let a bare ancestor .supabase directory capture a nested checkout", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-home-" });
      yield* Effect.gen(function* () {
        const parentRoot = path.join(tempDir, "workspace");
        const cwd = path.join(parentRoot, "test-cli-v3");
        yield* fs.makeDirectory(path.join(parentRoot, ".supabase"), { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });

        const projectHome = yield* ProjectHome.pipe(
          Effect.provide(
            buildLayer({
              cwd,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
            }),
          ),
        );

        expect(projectHome.projectRoot).toBe(cwd);
        expect(projectHome.projectHomeDir).toBe(path.join(cwd, ".supabase"));
        expect(projectHome.projectLinkPath).toBe(path.join(cwd, ".supabase", "project.json"));
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("creates the repo-local .supabase directory lazily", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-home-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        const projectHome = yield* ProjectHome.pipe(
          Effect.provide(
            buildLayer({
              cwd: projectRoot,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
            }),
          ),
        );

        yield* projectHome.ensureProjectHomeDir;
        yield* fs.writeFileString(projectHome.projectLinkPath, "{}\n");
        expect(yield* fs.readFileString(projectHome.projectLinkPath)).toBe("{}\n");
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("dies with ProjectHomeNotDirectoryError when a FILE occupies the .supabase path", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-home-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        yield* fs.makeDirectory(projectRoot, { recursive: true });
        yield* fs.writeFileString(path.join(projectRoot, ".supabase"), "not a directory\n");

        const projectHome = yield* ProjectHome.pipe(
          Effect.provide(
            buildLayer({
              cwd: projectRoot,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
            }),
          ),
        );

        const exit = yield* projectHome.ensureProjectHomeDir.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defect = Cause.findDefect(exit.cause);
          expect(Result.isSuccess(defect)).toBe(true);
          if (Result.isSuccess(defect)) {
            expect(defect.success).toBeInstanceOf(ProjectHomeNotDirectoryError);
            expect(defect.success).toMatchObject({ _tag: "ProjectHomeNotDirectoryError" });
            expect((defect.success as ProjectHomeNotDirectoryError).message).toContain(
              "could not be created",
            );
          }
        }
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live(
    "dies with ProjectHomeNotDirectoryError (BadResource) when a FILE occupies an ancestor of the project home path",
    () => {
      // Distinct from the AlreadyExists case above: here `.supabase` itself
      // doesn't exist, but a FILE sits on one of ITS OWN parent directories
      // (`<tempDir>/proj`), so `mkdir(..., { recursive: true })` fails with
      // ENOTDIR (-> PlatformError reason "BadResource") while trying to
      // traverse through it, rather than EEXIST on the leaf itself.
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-home-" });
        yield* Effect.gen(function* () {
          const fileAsDir = path.join(tempDir, "proj");
          const cwd = path.join(fileAsDir, "child");
          yield* fs.writeFileString(fileAsDir, "not a directory\n");

          const projectHome = yield* ProjectHome.pipe(
            Effect.provide(
              buildLayer({
                cwd,
                homeDir: path.join(tempDir, ".home"),
                env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
              }),
            ),
          );

          const exit = yield* projectHome.ensureProjectHomeDir.pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const defect = Cause.findDefect(exit.cause);
            expect(Result.isSuccess(defect)).toBe(true);
            if (Result.isSuccess(defect)) {
              expect(defect.success).toBeInstanceOf(ProjectHomeNotDirectoryError);
              expect(defect.success).toMatchObject({ _tag: "ProjectHomeNotDirectoryError" });
              expect((defect.success as ProjectHomeNotDirectoryError).message).toContain(
                "could not be created",
              );
            }
          }
        }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});
