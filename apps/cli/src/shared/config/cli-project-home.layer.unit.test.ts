import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { cliProjectHomeLayer } from "./cli-project-home.layer.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";
import { CliProjectHome, CliProjectHomeNotDirectoryError } from "./cli-project-home.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-home-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir?: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
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
  it.live("resolves a repo-local project home from the nearest discovered config root", () => {
    const tempDir = makeTempDir();
    const repoRoot = join(tempDir, "repo");
    const packageRoot = join(repoRoot, "apps", "web");
    const cwd = join(packageRoot, "src");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(packageRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => mkdir(cwd, { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(packageRoot, "supabase", "config.toml"), 'project_id = "web"\n'),
      );

      const { cliProjectHome, cliProjectContext } = yield* Effect.gen(function* () {
        return {
          cliProjectHome: yield* CliProjectHome,
          cliProjectContext: yield* CliProjectContext,
        };
      }).pipe(Effect.provide(buildLayer({ cwd, env: { SUPABASE_HOME: supabaseHome } })));

      expect(Option.isSome(cliProjectContext.paths)).toBe(true);
      expect(cliProjectHome.projectRoot).toBe(packageRoot);
      expect(cliProjectHome.supabaseDir).toBe(join(packageRoot, "supabase"));
      expect(cliProjectHome.projectHomeDir).toBe(join(packageRoot, ".supabase"));
      expect(cliProjectHome.projectLocalVersionsPath).toBe(
        join(packageRoot, ".supabase", "local-versions.json"),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("falls back to the nearest linked project root when no project config exists", () => {
    const tempDir = makeTempDir();
    const repoRoot = join(tempDir, "repo");
    const projectRoot = join(repoRoot, "apps", "web");
    const cwd = join(projectRoot, "src", "feature");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, ".supabase", "project.json"), "{}\n"),
      );
      yield* Effect.tryPromise(() => mkdir(cwd, { recursive: true }));

      const layer = buildLayer({ cwd, env: { SUPABASE_HOME: join(tempDir, "supabase-home") } });
      const cliProjectHome = yield* Effect.gen(function* () {
        return yield* CliProjectHome;
      }).pipe(Effect.provide(layer));

      expect(cliProjectHome.projectRoot).toBe(projectRoot);
      expect(cliProjectHome.projectHomeDir).toBe(join(projectRoot, ".supabase"));
      expect(cliProjectHome.supabaseDir).toBe(join(projectRoot, "supabase"));
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("does not let a bare ancestor .supabase directory capture a nested checkout", () => {
    const tempDir = makeTempDir();
    const parentRoot = join(tempDir, "workspace");
    const cwd = join(parentRoot, "test-cli-v3");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(parentRoot, ".supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => mkdir(cwd, { recursive: true }));

      const layer = buildLayer({ cwd, env: { SUPABASE_HOME: join(tempDir, "supabase-home") } });
      const cliProjectHome = yield* Effect.gen(function* () {
        return yield* CliProjectHome;
      }).pipe(Effect.provide(layer));

      expect(cliProjectHome.projectRoot).toBe(cwd);
      expect(cliProjectHome.projectHomeDir).toBe(join(cwd, ".supabase"));
      expect(cliProjectHome.projectLinkPath).toBe(join(cwd, ".supabase", "project.json"));
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("creates the repo-local .supabase directory lazily", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");

    return Effect.gen(function* () {
      const layer = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: join(tempDir, "supabase-home") },
      });
      const cliProjectHome = yield* Effect.gen(function* () {
        return yield* CliProjectHome;
      }).pipe(Effect.provide(layer));

      yield* cliProjectHome.ensureCliProjectHomeDir;
      yield* Effect.tryPromise(() => writeFile(cliProjectHome.projectLinkPath, "{}\n"));
      expect(yield* Effect.tryPromise(() => readFile(cliProjectHome.projectLinkPath, "utf8"))).toBe(
        "{}\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "dies with CliProjectHomeNotDirectoryError when a FILE occupies the .supabase path",
    () => {
      const tempDir = makeTempDir();
      const projectRoot = join(tempDir, "repo");

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => mkdir(projectRoot, { recursive: true }));
        yield* Effect.tryPromise(() =>
          writeFile(join(projectRoot, ".supabase"), "not a directory\n"),
        );

        const layer = buildLayer({
          cwd: projectRoot,
          env: { SUPABASE_HOME: join(tempDir, "supabase-home") },
        });
        const cliProjectHome = yield* Effect.gen(function* () {
          return yield* CliProjectHome;
        }).pipe(Effect.provide(layer));

        const exit = yield* cliProjectHome.ensureCliProjectHomeDir.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defect = Cause.findDefect(exit.cause);
          expect(Result.isSuccess(defect)).toBe(true);
          if (Result.isSuccess(defect)) {
            expect(defect.success).toBeInstanceOf(CliProjectHomeNotDirectoryError);
            expect(defect.success).toMatchObject({ _tag: "CliProjectHomeNotDirectoryError" });
            expect((defect.success as CliProjectHomeNotDirectoryError).message).toContain(
              "could not be created",
            );
          }
        }
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live(
    "dies with CliProjectHomeNotDirectoryError (BadResource) when a FILE occupies an ancestor of the project home path",
    () => {
      // Distinct from the AlreadyExists case above: here `.supabase` itself
      // doesn't exist, but a FILE sits on one of ITS OWN parent directories
      // (`<tempDir>/proj`), so `mkdir(..., { recursive: true })` fails with
      // ENOTDIR (-> PlatformError reason "BadResource") while trying to
      // traverse through it, rather than EEXIST on the leaf itself.
      const tempDir = makeTempDir();
      const fileAsDir = join(tempDir, "proj");
      const cwd = join(fileAsDir, "child");

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeFile(fileAsDir, "not a directory\n"));

        const layer = buildLayer({
          cwd,
          env: { SUPABASE_HOME: join(tempDir, "supabase-home") },
        });
        const cliProjectHome = yield* Effect.gen(function* () {
          return yield* CliProjectHome;
        }).pipe(Effect.provide(layer));

        const exit = yield* cliProjectHome.ensureCliProjectHomeDir.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defect = Cause.findDefect(exit.cause);
          expect(Result.isSuccess(defect)).toBe(true);
          if (Result.isSuccess(defect)) {
            expect(defect.success).toBeInstanceOf(CliProjectHomeNotDirectoryError);
            expect(defect.success).toMatchObject({ _tag: "CliProjectHomeNotDirectoryError" });
            expect((defect.success as CliProjectHomeNotDirectoryError).message).toContain(
              "could not be created",
            );
          }
        }
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );
});
