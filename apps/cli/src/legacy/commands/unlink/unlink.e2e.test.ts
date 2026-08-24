import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";

function runInTempProject<A, E>(
  use: (
    projectDir: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectory({ prefix: "sb-unlink-e2e-" });
        return yield* use(projectDir, fs, path).pipe(
          Effect.ensuring(
            fs.remove(projectDir, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
}

describe("supabase unlink (legacy)", () => {
  // Golden path: with a seeded `supabase/.temp/project-ref`, a real subprocess
  // removes the temp dir and prints the Finished line. No network is involved.
  test("removes supabase/.temp and prints Finished when linked", { timeout: E2E_TIMEOUT_MS }, () =>
    runInTempProject((projectDir, fs, path) =>
      Effect.gen(function* () {
        const tempDir = path.join(projectDir, "supabase", ".temp");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        yield* fs.writeFileString(path.join(tempDir, "project-ref"), TEST_PROJECT_REF);
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["unlink"], {
          entrypoint: "legacy",
          cwd: projectDir,
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Finished supabase unlink.");
        expect(stderr).toContain(`Unlinking project: ${TEST_PROJECT_REF}`);
        expect(yield* fs.exists(tempDir)).toBe(false);
      }),
    ),
  );

  // The not-linked path exits non-zero with the `ErrNotLinked` message.
  test(
    "without a linked project exits 1 with the not-linked message",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runInTempProject((projectDir) =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["unlink"], {
            entrypoint: "legacy",
            cwd: projectDir,
          });
          expect(exitCode).toBe(1);
          expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
        }),
      ),
  );
});
