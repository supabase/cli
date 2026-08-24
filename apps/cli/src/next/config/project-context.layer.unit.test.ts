import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { ProjectContext } from "./project-context.service.ts";

function buildLayer(opts: { cwd: string; homeDir: string; env?: Record<string, string> }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  return projectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
}

describe("projectContextLayer", () => {
  it.live("loads when supabase/config.toml uses env() on numeric fields (CLI-1489)", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-context-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectRoot, "supabase", "config.toml"),
          [
            'project_id = "with-env-ports"',
            "",
            "[api]",
            'port = "env(SUPABASE_API_PORT)"',
            "",
            "[db]",
            'port = "env(SUPABASE_DB_PORT)"',
            "",
            "[analytics]",
            'port = "env(SUPABASE_ANALYTICS_PORT)"',
            "",
          ].join("\n"),
        );

        const projectContext = yield* ProjectContext.pipe(
          Effect.provide(
            buildLayer({
              cwd: projectRoot,
              homeDir: path.join(tempDir, ".home"),
              env: {
                SUPABASE_API_PORT: "54321",
                SUPABASE_DB_PORT: "54322",
                SUPABASE_ANALYTICS_PORT: "54327",
              },
            }),
          ),
        );

        expect(Option.isSome(projectContext.paths)).toBe(true);
        if (Option.isSome(projectContext.paths)) {
          expect(projectContext.paths.value.projectRoot).toBe(projectRoot);
        }
        expect(Option.isSome(projectContext.projectEnv)).toBe(true);
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("preserves array-shaped environment variables from the provider", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-context-array-" });
      yield* Effect.gen(function* () {
        const projectRoot = path.join(tempDir, "repo");
        yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectRoot, "supabase", "config.toml"),
          'project_id = "array-env"\n',
        );

        const projectContext = yield* ProjectContext.pipe(
          Effect.provide(
            buildLayer({
              cwd: projectRoot,
              homeDir: path.join(tempDir, ".home"),
              env: {
                SUPABASE_API_CORS_ORIGINS_0: "https://one.example",
                SUPABASE_API_CORS_ORIGINS_1: "https://two.example",
              },
            }),
          ),
        );

        expect(Option.isSome(projectContext.projectEnv)).toBe(true);
        if (Option.isSome(projectContext.projectEnv)) {
          expect(projectContext.projectEnv.value.values.SUPABASE_API_CORS_ORIGINS_0).toBe(
            "https://one.example",
          );
          expect(projectContext.projectEnv.value.values.SUPABASE_API_CORS_ORIGINS_1).toBe(
            "https://two.example",
          );
        }
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("returns empty context when no supabase project is found", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-project-context-" });
      yield* Effect.gen(function* () {
        const projectContext = yield* ProjectContext.pipe(
          Effect.provide(buildLayer({ cwd: tempDir, homeDir: path.join(tempDir, ".home") })),
        );

        expect(Option.isNone(projectContext.paths)).toBe(true);
        expect(Option.isNone(projectContext.projectEnv)).toBe(true);
      }).pipe(Effect.ensuring(fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));
    }).pipe(Effect.provide(BunServices.layer));
  });
});
