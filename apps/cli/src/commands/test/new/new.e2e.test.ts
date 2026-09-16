import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: `test new` writes a real file through the compiled-binary
 * boundary. Validates `Command.provide` + the runtime layer + FileSystem wiring.
 * Branch detail (json/stream-json, exists/write errors) is covered by the
 * integration suite.
 */
describe("supabase test new", () => {
  it.live(
    "scaffolds supabase/tests/<name>_test.sql and prints the created path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-test-new-e2e-",
        });
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "supabase", "config.toml"),
          'project_id = "test-new-e2e"\n',
        );

        const { exitCode, stdout } = yield* runSupabaseEffect(["test", "new", "pet"], {
          cwd: projectDir,
        });
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Created new pgtap test at");
        const target = path.join(projectDir, "supabase", "tests", "pet_test.sql");
        expect(yield* fs.exists(target)).toBe(true);
        expect(yield* fs.readFileString(target)).toContain("SELECT plan(1);");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
