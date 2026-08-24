import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";
import { projectLocalServiceVersionsLayer } from "./project-local-service-versions.layer.ts";
import { ProjectHome } from "./project-home.service.ts";
import {
  LocalServiceVersionsStateSchema,
  ProjectLocalServiceVersions,
} from "./project-local-service-versions.service.ts";

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
  const discoveredProjectLocalServiceVersionsLayer = projectLocalServiceVersionsLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );

  return Layer.mergeAll(
    discoveredProjectContextLayer,
    discoveredCliConfigLayer,
    discoveredProjectHomeLayer,
    discoveredProjectLocalServiceVersionsLayer,
  );
}

describe("projectLocalServiceVersionsLayer", () => {
  it.live("loads local service version overrides from repo-local state", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-local-versions-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        const supabaseHome = path.join(tempDir, "supabase-home");
        yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.toml"), "");

        const layer = buildLayer({
          cwd: projectRoot,
          homeDir: path.join(tempDir, ".home"),
          env: { SUPABASE_HOME: supabaseHome },
        });
        const projectHome = yield* ProjectHome.pipe(Effect.provide(layer));
        const localVersions = yield* ProjectLocalServiceVersions.pipe(Effect.provide(layer));

        yield* projectHome.ensureProjectHomeDir;
        const contents = yield* Schema.encodeEffect(
          Schema.fromJsonString(LocalServiceVersionsStateSchema),
        )({
          updatedAt: "2026-03-21T12:00:00.000Z",
          versions: {
            auth: "v2.180.0",
            storage: "1.40.0",
          },
        });
        yield* fs.writeFileString(projectHome.projectLocalVersionsPath, contents);

        const loaded = yield* localVersions.load;
        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.versions).toEqual({
            auth: "v2.180.0",
            storage: "1.40.0",
          });
        }
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("returns none when no local override file exists", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-local-versions-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.toml"), "");

        const localVersions = yield* ProjectLocalServiceVersions.pipe(
          Effect.provide(
            buildLayer({
              cwd: projectRoot,
              homeDir: path.join(tempDir, ".home"),
              env: { SUPABASE_HOME: path.join(tempDir, "supabase-home") },
            }),
          ),
        );

        const loaded = yield* localVersions.load;
        expect(Option.isNone(loaded)).toBe(true);
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });
});
