import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

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

  it.live(
    "rejects traversal without writing files or terminal controls",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-test-new-rejected-e2e-",
        });
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "supabase", "config.toml"),
          'project_id = "test-new-rejected-e2e"\n',
        );

        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["test", "new", "../../nested/\u001b[2Jx", "--output-format", "text"],
          { cwd: projectDir, env: { NO_COLOR: "1", FORCE_COLOR: undefined } },
        );
        expect(exitCode, stderr).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain('invalid test name: "../../nested/[2Jx"');
        expect(stderr).not.toContain("\u001b");
        expect(yield* fs.exists(path.join(projectDir, "nested"))).toBe(false);
        expect(yield* fs.exists(path.join(projectDir, "supabase", "tests"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
