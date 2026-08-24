import { BunServices } from "@effect/platform-bun";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: `test new` writes a real file through the compiled-binary
 * boundary. Validates `Command.provide` + the runtime layer + FileSystem wiring.
 * Branch detail (json/stream-json, exists/write errors) is covered by the
 * integration suite.
 */
describe("supabase test new (legacy)", () => {
  let projectDir: string;

  beforeAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        projectDir = yield* fs.makeTempDirectory({ prefix: "supabase-test-new-e2e-" });
        const supabaseDir = path.join(projectDir, "supabase");
        yield* fs.makeDirectory(supabaseDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(supabaseDir, "config.toml"),
          'project_id = "test-new-e2e"\n',
        );
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(projectDir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  test(
    "scaffolds supabase/tests/<name>_test.sql and prints the created path",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const { exitCode, stdout } = yield* Effect.tryPromise(() =>
            runSupabase(["test", "new", "pet"], {
              entrypoint: "legacy",
              cwd: projectDir,
            }),
          );
          expect(exitCode).toBe(0);
          expect(stdout).toContain("Created new pgtap test at");
          const target = path.join(projectDir, "supabase", "tests", "pet_test.sql");
          expect(yield* fs.exists(target)).toBe(true);
          expect(yield* fs.readFileString(target)).toContain("SELECT plan(1);");
        }).pipe(Effect.provide(BunServices.layer)),
      ),
  );
});
