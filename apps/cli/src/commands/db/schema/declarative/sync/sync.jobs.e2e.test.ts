import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../../../../tests/helpers/cli.ts";
import {
  commandFailure,
  migrationFiles,
  SCENARIO_COMMAND_TIMEOUT_MS,
  setUpProject,
  TEST_TIMEOUT_MS,
  withTempStackProject,
} from "./sync.e2e-fixture.ts";

describe("db schema declarative sync extension jobs (e2e)", () => {
  it.live(
    "adds, renames, and drops extension-managed jobs and queues",
    () =>
      withTempStackProject((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectDir = project.dir;
          yield* setUpProject(projectDir);

          const jobsPath = path.join(projectDir, "supabase", "schemas", "jobs.sql");
          const runSync = (name: string) =>
            runSupabaseEffect(
              [
                "db",
                "schema",
                "declarative",
                "sync",
                "--no-apply",
                "--name",
                name,
                "--experimental",
              ],
              {
                cwd: projectDir,
                exitTimeoutMs: SCENARIO_COMMAND_TIMEOUT_MS,
              },
            );
          // A next-engine plan may span several ordered migration files; read every
          // file a sync added rather than only the last one.
          const syncAndReadSql = (name: string) =>
            Effect.gen(function* () {
              const before = new Set(yield* migrationFiles(projectDir));
              const result = yield* runSync(name);
              expect(result.exitCode, commandFailure(result)).toBe(0);
              const added = (yield* migrationFiles(projectDir)).filter((file) => !before.has(file));
              expect(added.length, "sync did not write a migration").toBeGreaterThan(0);
              return {
                result,
                sql: (yield* Effect.forEach(added, (file) =>
                  fs.readFileString(path.join(projectDir, "supabase", "migrations", file)),
                )).join("\n"),
              };
            });

          yield* fs.writeFileString(
            jobsPath,
            [
              "select cron.schedule('nightly_cleanup', '0 3 * * *', $$delete from public.disposable_note$$);",
              "select pgmq.create('emails');",
              "",
            ].join("\n"),
          );
          // pg-delta renders a job through `cron.schedule_in_database(...)`.
          const added = yield* syncAndReadSql("add_jobs");
          expect(added.sql).toMatch(/cron\.schedule(?:_in_database)?\('nightly_cleanup'/);
          expect(added.sql).toContain("pgmq.create('emails')");

          // Rename the job and drop the queue — this must not be refused as a legacy export.
          yield* fs.writeFileString(
            jobsPath,
            "select cron.schedule('weekly_cleanup', '0 3 * * 0', $$delete from public.disposable_note$$);\n",
          );
          const removed = yield* syncAndReadSql("rename_job_drop_queue");
          expect(`${removed.result.stdout}${removed.result.stderr}`).not.toContain(
            "legacy pg-delta export",
          );
          expect(removed.sql).toContain("cron.unschedule('nightly_cleanup')");
          expect(removed.sql).toMatch(/cron\.schedule(?:_in_database)?\('weekly_cleanup'/);
          expect(removed.sql).toContain("pgmq.drop_queue('emails')");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    TEST_TIMEOUT_MS,
  );
});
