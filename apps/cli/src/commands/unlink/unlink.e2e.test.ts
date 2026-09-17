import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";

describe("supabase unlink", () => {
  // Golden path: with a seeded `supabase/.temp/project-ref`, a real subprocess
  // removes the temp dir and prints the Finished line. No network is involved.
  it.live(
    "removes supabase/.temp and prints Finished when linked",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-unlink-e2e-linked-",
        });
        const tempDir = path.join(projectDir, "supabase", ".temp");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        yield* fs.writeFileString(path.join(tempDir, "project-ref"), TEST_PROJECT_REF);

        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["unlink"], {
          cwd: projectDir,
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Finished supabase unlink.");
        expect(stderr).toContain(`Unlinking project: ${TEST_PROJECT_REF}`);
        const tempDirExists = yield* fs.exists(tempDir);
        expect(tempDirExists).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  // The not-linked path exits non-zero with the `ErrNotLinked` message.
  it.live(
    "without a linked project exits 1 with the not-linked message",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-unlink-e2e-not-linked-",
        });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["unlink"], {
          cwd: projectDir,
        });
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
