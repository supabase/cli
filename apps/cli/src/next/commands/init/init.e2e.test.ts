import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const INIT_TIMEOUT_MS = 5_000;

describe("supabase init", () => {
  test("creates config.toml in the current directory", { timeout: INIT_TIMEOUT_MS }, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-init-e2e-" });
          const { stdout, exitCode } = yield* Effect.tryPromise(() =>
            runSupabase(["init"], { cwd: tempDir }),
          );

          expect(exitCode).toBe(0);
          expect(stdout).toContain("Initialized Supabase project.");

          const content = yield* fs.readFileString(path.join(tempDir, "supabase", "config.toml"));
          expect(content).toContain("major_version = 17");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ),
  );
});
