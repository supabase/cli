import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { ProjectContext } from "./project-context.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-context-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string> }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: join(opts.cwd, ".home"),
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
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          join(projectRoot, "supabase", "config.toml"),
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
        ),
      );

      const projectContext = yield* Effect.gen(function* () {
        return yield* ProjectContext;
      }).pipe(
        Effect.provide(
          buildLayer({
            cwd: projectRoot,
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("returns empty context when no supabase project is found", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const projectContext = yield* Effect.gen(function* () {
        return yield* ProjectContext;
      }).pipe(Effect.provide(buildLayer({ cwd: tempDir })));

      expect(Option.isNone(projectContext.paths)).toBe(true);
      expect(Option.isNone(projectContext.projectEnv)).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
