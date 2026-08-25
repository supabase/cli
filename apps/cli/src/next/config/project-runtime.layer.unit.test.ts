import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { cliProjectCommandBaseLayer } from "./project-runtime.layer.ts";
import { CliProjectHome } from "./cli-project-home.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-runtime-"));
}

describe("project-runtime.layer", () => {
  it.live("builds the shared project runtime for config-discovered checkouts", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const previousCwd = process.cwd();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
      );
      yield* Effect.sync(() => process.chdir(projectRoot));

      const cliProjectHome = yield* Effect.gen(function* () {
        return yield* CliProjectHome;
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, cliProjectCommandBaseLayer)));
      const resolvedProjectRoot = yield* Effect.tryPromise(() => realpath(projectRoot));
      expect(cliProjectHome.projectRoot).toBe(resolvedProjectRoot);
      expect(cliProjectHome.projectHomeDir).toBe(join(resolvedProjectRoot, ".supabase"));
    }).pipe(
      Effect.ensuring(Effect.sync(() => process.chdir(previousCwd))),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
