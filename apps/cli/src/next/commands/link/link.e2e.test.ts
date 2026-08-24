import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as EffectPath from "effect/Path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const { join } = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));

const withFileSystem = <A>(
  effect: Effect.Effect<A, PlatformError, FileSystem.FileSystem>,
): Effect.Effect<A, PlatformError, never> => effect.pipe(Effect.provide(BunFileSystem.layer));

const mkdir = (path: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path, { recursive: true });
    }),
  );

const writeFile = (path: string, content: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path, content);
    }),
  );

const rm = (path: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true, force: true });
    }),
  );

describe("supabase link", () => {
  it.live("fails with platform auth error instead of root fallback services", () => {
    const tempDir = join(tmpdir(), `supabase-link-e2e-${randomUUID()}`);
    const projectRoot = join(tempDir, "repo");

    return Effect.gen(function* () {
      yield* mkdir(join(projectRoot, "supabase"));
      yield* writeFile(join(projectRoot, "supabase", "config.toml"), "# test project\n");

      const { stdout, stderr, exitCode } = yield* Effect.tryPromise(() =>
        runSupabase(["link", "--project-ref", "abcdefghijklmnopqrst"], { cwd: projectRoot }),
      );

      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("You are not logged in to Supabase.");
      expect(`${stdout}${stderr}`).not.toContain("unexpected root credentials access");
      expect(`${stdout}${stderr}`).not.toContain("unexpected root platform api client access");
    }).pipe(Effect.ensuring(rm(tempDir).pipe(Effect.orDie)), Effect.provide(BunServices.layer));
  });
});
