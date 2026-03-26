import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";
import { ProjectContext } from "./project-context.service.ts";
import { ProjectHome } from "./project-home.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-home-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir?: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? join(opts.cwd, ".home"),
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
  );
  const discoveredProjectHomeLayer = projectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(discoveredCliConfigLayer),
  );

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredProjectContextLayer,
    discoveredCliConfigLayer,
    discoveredProjectHomeLayer,
  );
}

describe("projectHomeLayer", () => {
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

      const { projectHome, projectContext } = yield* Effect.gen(function* () {
        return {
          projectHome: yield* ProjectHome,
          projectContext: yield* ProjectContext,
        };
      }).pipe(Effect.provide(buildLayer({ cwd, env: { SUPABASE_HOME: supabaseHome } })));

      expect(Option.isSome(projectContext.paths)).toBe(true);
      expect(projectHome.projectRoot).toBe(packageRoot);
      expect(projectHome.supabaseDir).toBe(join(packageRoot, "supabase"));
      expect(projectHome.projectHomeDir).toBe(join(packageRoot, ".supabase"));
      expect(projectHome.projectLocalVersionsPath).toBe(
        join(packageRoot, ".supabase", "local-versions.json"),
      );
      expect(projectHome.stackStatePath("default")).toBe(
        join(packageRoot, ".supabase", "stacks", "default", "state.json"),
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
      const projectHome = yield* Effect.gen(function* () {
        return yield* ProjectHome;
      }).pipe(Effect.provide(layer));

      expect(projectHome.projectRoot).toBe(projectRoot);
      expect(projectHome.projectHomeDir).toBe(join(projectRoot, ".supabase"));
      expect(projectHome.supabaseDir).toBe(join(projectRoot, "supabase"));
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
      const projectHome = yield* Effect.gen(function* () {
        return yield* ProjectHome;
      }).pipe(Effect.provide(layer));

      expect(projectHome.projectRoot).toBe(cwd);
      expect(projectHome.projectHomeDir).toBe(join(cwd, ".supabase"));
      expect(projectHome.projectLinkPath).toBe(join(cwd, ".supabase", "project.json"));
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
      const projectHome = yield* Effect.gen(function* () {
        return yield* ProjectHome;
      }).pipe(Effect.provide(layer));

      yield* projectHome.ensureProjectHomeDir;
      yield* Effect.tryPromise(() => writeFile(projectHome.projectLinkPath, "{}\n"));
      expect(yield* Effect.tryPromise(() => readFile(projectHome.projectLinkPath, "utf8"))).toBe(
        "{}\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
