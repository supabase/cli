import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDbPullWriteError } from "./pull.errors.ts";
import { legacyUpdateMigrationHistory, type LegacyPulledMigration } from "./pull.sync.ts";

// Records exec statements and successful upserts in one ordered log so the tests
// can assert the transaction envelope (BEGIN / UPSERT / COMMIT / ROLLBACK) around
// the version writes. `failUpsertAt` fails the Nth upsert to simulate a dropped
// connection mid-loop.
function mockSession(opts: { readonly failUpsertAt?: number } = {}) {
  const calls: Array<string> = [];
  let upsertCount = 0;
  const session: LegacyDbSession = {
    exec: (sql: string) => Effect.sync(() => void calls.push(sql)),
    // `legacyUpdateMigrationHistory` owns its transaction envelope statement by
    // statement; it never batches.
    execBatch: () => Effect.die("execBatch unused"),
    query: (sql: string) => {
      if (/INSERT INTO supabase_migrations/u.test(sql)) {
        upsertCount += 1;
        if (opts.failUpsertAt === upsertCount) {
          return Effect.fail(new LegacyDbExecError({ message: "connection reset by peer" }));
        }
        calls.push("UPSERT");
      }
      return Effect.succeed([] as ReadonlyArray<Record<string, unknown>>);
    },
    extensionExists: () => Effect.die("extensionExists unused"),
    copyToCsv: () => Effect.die("copyToCsv unused"),
    queryRaw: () => Effect.die("queryRaw unused"),
  };
  return { session, calls };
}

function writeMigrations(dir: string): ReadonlyArray<LegacyPulledMigration> {
  const migrations: ReadonlyArray<LegacyPulledMigration> = [
    { path: join(dir, "20240101000000_a.sql"), version: "20240101000000" },
    { path: join(dir, "20240101000001_b.sql"), version: "20240101000001" },
  ];
  writeFileSync(migrations[0]!.path, "create table a ();");
  writeFileSync(migrations[1]!.path, "create table b ();");
  return migrations;
}

describe("legacyUpdateMigrationHistory", () => {
  it.effect("wraps the upserts in one BEGIN + N upserts + COMMIT transaction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = mkdtempSync(join(tmpdir(), "pull-sync-"));
      const migrations = writeMigrations(dir);
      const out = mockOutput();
      const { session, calls } = mockSession();

      yield* legacyUpdateMigrationHistory(session, fs, path, migrations).pipe(
        Effect.provide(out.layer),
      );

      // The create-table setup runs its own BEGIN/COMMIT first; the upsert
      // transaction is the trailing envelope around every version write.
      expect(calls).not.toContain("ROLLBACK");
      expect(calls.slice(-4)).toEqual(["BEGIN", "UPSERT", "UPSERT", "COMMIT"]);
      // The success line matches the established output contract.
      expect(out.stderrText).toContain(
        "Repaired migration history: [20240101000000 20240101000001] => applied",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rolls back and surfaces the error when an upsert fails mid-loop", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = mkdtempSync(join(tmpdir(), "pull-sync-"));
      const migrations = writeMigrations(dir);
      const out = mockOutput();
      const { session, calls } = mockSession({ failUpsertAt: 2 });

      const error = yield* legacyUpdateMigrationHistory(session, fs, path, migrations).pipe(
        Effect.provide(out.layer),
        Effect.flip,
      );

      // First upsert applied, second failed → the upsert transaction ends in
      // ROLLBACK, never COMMIT (the create-table setup's own COMMIT ran earlier).
      expect(calls.slice(-3)).toEqual(["BEGIN", "UPSERT", "ROLLBACK"]);
      expect(calls[calls.length - 1]).toBe("ROLLBACK");
      // Error message shape stays byte-identical to the pre-transaction version.
      expect(error).toBeInstanceOf(LegacyDbPullWriteError);
      expect(error.message).toBe("failed to update migration table: connection reset by peer");
      // No success line when the repair failed.
      expect(out.stderrText).not.toContain("Repaired migration history");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
