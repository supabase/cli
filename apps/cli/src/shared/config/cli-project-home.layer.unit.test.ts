import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { cliProjectHomeLayer } from "./cli-project-home.layer.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";
import { CliProjectHome, CliProjectHomeNotDirectoryError } from "./cli-project-home.service.ts";

const makeTempDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-project-home-" }),
);

function buildLayer(
  path: Path.Path,
  opts: { cwd: string; env?: Record<string, string>; homeDir?: string },
) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? path.join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
  );
  const discoveredCliProjectHomeLayer = cliProjectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
    Layer.provide(discoveredCliSettingsLayer),
  );

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredCliProjectContextLayer,
    discoveredCliSettingsLayer,
    discoveredCliProjectHomeLayer,
  );
}

describe("cliProjectHomeLayer", () => {
  it.live("resolves a repo-local project home from the nearest discovered config root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
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

      const { cliProjectHome, cliProjectContext } = yield* Effect.gen(function* () {
        return {
          cliProjectHome: yield* CliProjectHome,
          cliProjectContext: yield* CliProjectContext,
        };
      }).pipe(Effect.provide(buildLayer(path, { cwd, env: { SUPABASE_HOME: supabaseHome } })));

      expect(Option.isSome(cliProjectContext.paths)).toBe(true);
      expect(cliProjectHome.projectRoot).toBe(packageRoot);
      expect(cliProjectHome.supabaseDir).toBe(path.join(packageRoot, "supabase"));
      expect(cliProjectHome.projectHomeDir).toBe(path.join(packageRoot, ".supabase"));
      expect(cliProjectHome.projectLocalVersionsPath).toBe(
        path.join(packageRoot, ".supabase", "local-versions.json"),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("falls back to the nearest linked project root when no project config exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const repoRoot = path.join(tempDir, "repo");
      const projectRoot = path.join(repoRoot, "apps", "web");
      const cwd = path.join(projectRoot, "src", "feature");

      yield* fs.makeDirectory(path.join(projectRoot, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(projectRoot, ".supabase", "project.json"), "{}\n");
      yield* fs.makeDirectory(cwd, { recursive: true });

      const layer = buildLayer(path, {
        cwd,
        env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
      });
      const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));

      expect(cliProjectHome.projectRoot).toBe(projectRoot);
      expect(cliProjectHome.projectHomeDir).toBe(path.join(projectRoot, ".supabase"));
      expect(cliProjectHome.supabaseDir).toBe(path.join(projectRoot, "supabase"));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("does not let a bare ancestor .supabase directory capture a nested checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const parentRoot = path.join(tempDir, "workspace");
      const cwd = path.join(parentRoot, "test-cli-v3");

      yield* fs.makeDirectory(path.join(parentRoot, ".supabase"), { recursive: true });
      yield* fs.makeDirectory(cwd, { recursive: true });

      const layer = buildLayer(path, {
        cwd,
        env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
      });
      const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));

      expect(cliProjectHome.projectRoot).toBe(cwd);
      expect(cliProjectHome.projectHomeDir).toBe(path.join(cwd, ".supabase"));
      expect(cliProjectHome.projectLinkPath).toBe(path.join(cwd, ".supabase", "project.json"));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("creates the repo-local .supabase directory lazily", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");

      const layer = buildLayer(path, {
        cwd: projectRoot,
        env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
      });
      const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));

      yield* cliProjectHome.ensureCliProjectHomeDir;
      yield* fs.writeFileString(cliProjectHome.projectLinkPath, "{}\n");
      expect(yield* fs.readFileString(cliProjectHome.projectLinkPath)).toBe("{}\n");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "fails with CliProjectHomeNotDirectoryError when a FILE occupies the .supabase path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* makeTempDir;
        const projectRoot = path.join(tempDir, "repo");

        yield* fs.makeDirectory(projectRoot, { recursive: true });
        yield* fs.writeFileString(path.join(projectRoot, ".supabase"), "not a directory\n");

        const layer = buildLayer(path, {
          cwd: projectRoot,
          env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
        });
        const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));

        const exit = yield* cliProjectHome.ensureCliProjectHomeDir.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(CliProjectHomeNotDirectoryError);
            expect(error.value).toMatchObject({ _tag: "CliProjectHomeNotDirectoryError" });
            expect(error.value.message).toContain("could not be created");
          }
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "fails with CliProjectHomeNotDirectoryError (BadResource) when a FILE occupies an ancestor of the project home path",
    () =>
      // Distinct from the AlreadyExists case above: here `.supabase` doesn't exist, but a file
      // sits on one of its own parent directories, so `mkdir` fails with ENOTDIR while
      // traversing, not EEXIST on the leaf itself.
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* makeTempDir;
        const fileAsDir = path.join(tempDir, "proj");
        const cwd = path.join(fileAsDir, "child");

        yield* fs.writeFileString(fileAsDir, "not a directory\n");

        const layer = buildLayer(path, {
          cwd,
          env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
        });
        const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));

        const exit = yield* cliProjectHome.ensureCliProjectHomeDir.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(CliProjectHomeNotDirectoryError);
            expect(error.value).toMatchObject({ _tag: "CliProjectHomeNotDirectoryError" });
            expect(error.value.message).toContain("could not be created");
          }
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
