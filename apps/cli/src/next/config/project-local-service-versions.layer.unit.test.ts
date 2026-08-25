import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";
import { projectLocalServiceVersionsLayer } from "./project-local-service-versions.layer.ts";
import { ProjectHome } from "./project-home.service.ts";
import { ProjectLocalServiceVersions } from "./project-local-service-versions.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-local-versions-"));
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
  const discoveredProjectHomeLayer = projectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
    Layer.provide(discoveredCliSettingsLayer),
  );
  const discoveredProjectLocalServiceVersionsLayer = projectLocalServiceVersionsLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredCliProjectContextLayer,
    discoveredCliSettingsLayer,
    discoveredProjectHomeLayer,
    discoveredProjectLocalServiceVersionsLayer,
  );
}

describe("projectLocalServiceVersionsLayer", () => {
  it.live("loads local service version overrides from repo-local state", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(join(projectRoot, "supabase", "config.toml"), ""));

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const { projectHome, localVersions } = yield* Effect.gen(function* () {
        return {
          projectHome: yield* ProjectHome,
          localVersions: yield* ProjectLocalServiceVersions,
        };
      }).pipe(Effect.provide(layer));

      yield* projectHome.ensureProjectHomeDir;
      yield* Effect.tryPromise(() =>
        writeFile(
          projectHome.projectLocalVersionsPath,
          JSON.stringify(
            {
              updatedAt: "2026-03-21T12:00:00.000Z",
              versions: {
                auth: "v2.180.0",
                storage: "1.40.0",
              },
            },
            null,
            2,
          ),
        ),
      );

      const loaded = yield* localVersions.load;
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(loaded.value.versions).toEqual({
          auth: "v2.180.0",
          storage: "1.40.0",
        });
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("returns none when no local override file exists", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(join(projectRoot, "supabase", "config.toml"), ""));

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const localVersions = yield* Effect.gen(function* () {
        return yield* ProjectLocalServiceVersions;
      }).pipe(Effect.provide(layer));

      const loaded = yield* localVersions.load;
      expect(Option.isNone(loaded)).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
