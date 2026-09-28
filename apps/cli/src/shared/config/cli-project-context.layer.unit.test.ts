import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";

const makeTempDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-project-context-" }),
);

function buildLayer(path: Path.Path, opts: { cwd: string; env?: Record<string, string> }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: path.join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  return cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
}

describe("cliProjectContextLayer", () => {
  it.live("loads when supabase/config.toml uses env() on numeric fields (CLI-1489)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
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

      const cliProjectContext = yield* CliProjectContext.pipe(
        Effect.provide(
          buildLayer(path, {
            cwd: projectRoot,
            env: {
              SUPABASE_API_PORT: "54321",
              SUPABASE_DB_PORT: "54322",
              SUPABASE_ANALYTICS_PORT: "54327",
            },
          }),
        ),
      );

      expect(Option.isSome(cliProjectContext.paths)).toBe(true);
      if (Option.isSome(cliProjectContext.paths)) {
        expect(cliProjectContext.paths.value.projectRoot).toBe(projectRoot);
      }
      expect(Option.isSome(cliProjectContext.projectEnv)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("returns empty context when no supabase project is found", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;

      const cliProjectContext = yield* CliProjectContext.pipe(
        Effect.provide(buildLayer(path, { cwd: tempDir })),
      );

      expect(Option.isNone(cliProjectContext.paths)).toBe(true);
      expect(Option.isNone(cliProjectContext.projectEnv)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
