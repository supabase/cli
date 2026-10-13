import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { requireCliSuccess, runSupabaseEffect } from "../../../../../../tests/helpers/cli.ts";
import {
  commandFailure,
  migrationFiles,
  scenarioCommandOptions,
  setUpProject,
  TEST_TIMEOUT_MS,
  withTempStackProject,
} from "../../../../../../tests/helpers/declarative-sync-e2e.ts";

describe("db schema declarative sync (e2e)", () => {
  it.live(
    "applies a representative declarative schema and converges",
    () =>
      withTempStackProject((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectDir = project.dir;
          yield* setUpProject(projectDir);

          const sync = yield* runSupabaseEffect(
            [
              "db",
              "schema",
              "declarative",
              "sync",
              "--no-apply",
              "--name",
              "initial_declarative",
              "--experimental",
            ],
            scenarioCommandOptions(projectDir),
          );
          expect(sync.exitCode, commandFailure(sync)).toBe(0);

          const migrations = yield* migrationFiles(projectDir);
          expect(migrations.length).toBeGreaterThan(0);
          const sql = (yield* Effect.forEach(migrations, (file) =>
            fs.readFileString(path.join(projectDir, "supabase", "migrations", file)),
          )).join("\n");
          expect(sql).toContain("account_state");
          expect(sql).toContain("disposable_note");
          expect(sql).toContain("auth_user_emails");
          expect(sql).toContain("auth.users");
          expect(sql).not.toMatch(
            /CREATE\s+(?:SCHEMA|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(?:auth|storage|realtime)["']?/iu,
          );

          const reset = yield* runSupabaseEffect(
            ["db", "reset", "--local", "--no-seed"],
            scenarioCommandOptions(projectDir),
          );
          requireCliSuccess(reset, "db reset setup");

          const converged = yield* runSupabaseEffect(
            ["db", "schema", "declarative", "sync", "--no-apply", "--experimental"],
            scenarioCommandOptions(projectDir),
          );
          expect(converged.exitCode, commandFailure(converged)).toBe(0);
          expect(`${converged.stdout}${converged.stderr}`).toContain("No schema changes found");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    TEST_TIMEOUT_MS,
  );
});
