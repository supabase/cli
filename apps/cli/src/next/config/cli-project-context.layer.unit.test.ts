import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-context-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string> }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  return cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
}

describe("cliProjectContextLayer", () => {
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

      const cliProjectContext = yield* Effect.gen(function* () {
        return yield* CliProjectContext;
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

      expect(Option.isSome(cliProjectContext.paths)).toBe(true);
      if (Option.isSome(cliProjectContext.paths)) {
        expect(cliProjectContext.paths.value.projectRoot).toBe(projectRoot);
      }
      expect(Option.isSome(cliProjectContext.projectEnv)).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("returns empty context when no supabase project is found", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const cliProjectContext = yield* Effect.gen(function* () {
        return yield* CliProjectContext;
      }).pipe(Effect.provide(buildLayer({ cwd: tempDir })));

      expect(Option.isNone(cliProjectContext.paths)).toBe(true);
      expect(Option.isNone(cliProjectContext.projectEnv)).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
