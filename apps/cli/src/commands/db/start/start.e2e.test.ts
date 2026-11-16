import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  makeTempStackProject,
  runSupabaseEffect,
  withTempHome,
} from "../../../../tests/helpers/cli.ts";

const DB_START_COMMAND_TIMEOUT_MS = 480_000;
const DB_START_CLEANUP_TIMEOUT_MS = 120_000;
const DB_START_TEST_TIMEOUT_MS = DB_START_COMMAND_TIMEOUT_MS + DB_START_CLEANUP_TIMEOUT_MS;

describe("supabase db start (e2e)", () => {
  it.live(
    "boots the local database",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const project = yield* Effect.tryPromise(() =>
            makeTempStackProject("supabase-db-start-e2e-"),
          );
          yield* Effect.gen(function* () {
            const started = yield* runSupabaseEffect(["db", "start"], {
              cwd: project.dir,
              home: home.dir,
              exitTimeoutMs: DB_START_COMMAND_TIMEOUT_MS,
            });
            expect(started.exitCode, started.stderr).toBe(0);
            expect(`${started.stdout}${started.stderr}`).toMatch(
              /Starting database|Initialising schema/i,
            );
          }).pipe(
            Effect.ensuring(
              runSupabaseEffect(["stop", "--no-backup"], {
                cwd: project.dir,
                home: home.dir,
                exitTimeoutMs: DB_START_CLEANUP_TIMEOUT_MS,
              }).pipe(Effect.ignore),
            ),
          );
        }),
      ),
    DB_START_TEST_TIMEOUT_MS,
  );
});
