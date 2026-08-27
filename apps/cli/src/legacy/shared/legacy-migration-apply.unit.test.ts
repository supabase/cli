import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import type { LegacyDbConnectError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbBatchStatement, LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  legacyApplyMigrationFile,
  legacyApplySchemaFiles,
  legacyHasTransactionControl,
  legacyIsPipelineIncompatible,
  legacyMarkError,
  legacyRevertsToLoginRole,
  legacySeedGlobals,
} from "./legacy-migration-apply.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

class FakeExecError extends Data.TaggedError("LegacyDbExecError")<{
  readonly message: string;
  readonly code?: string;
  readonly detail?: string;
  readonly position?: number;
  readonly statementIndex?: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

function fakeSession(
  opts: {
    failOn?: string;
    failAfterBatch?: boolean;
    failWith?: { message: string; code?: string; detail?: string; position?: number };
    restoreRoleSql?: string;
    restoreSearchPathSql?: string;
  } = {},
) {
  const calls: Array<{
    kind: "exec" | "batch" | "query";
    sql: string;
    statements?: ReadonlyArray<LegacyDbBatchStatement>;
    params?: ReadonlyArray<unknown>;
  }> = [];
  const session: LegacyDbSession = {
    ...(opts.restoreRoleSql === undefined ? {} : { restoreRoleSql: opts.restoreRoleSql }),
    ...(opts.restoreSearchPathSql === undefined
      ? {}
      : { restoreSearchPathSql: opts.restoreSearchPathSql }),
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return opts.failOn !== undefined && sql.includes(opts.failOn)
        ? Effect.fail(new FakeExecError(opts.failWith ?? { message: "exec failed" }))
        : Effect.void;
    },
    execBatch: (statements) => {
      calls.push({
        kind: "batch",
        sql: statements.map(({ sql }) => sql).join(";\n"),
        statements,
      });
      const statementIndex = opts.failAfterBatch
        ? statements.length
        : statements.findIndex(({ sql }) =>
            opts.failOn === undefined ? false : sql.includes(opts.failOn),
          );
      return statementIndex >= 0
        ? Effect.fail(
            new FakeExecError({
              ...(opts.failWith ?? { message: "exec failed" }),
              statementIndex,
            }),
          )
        : Effect.void;
    },
    query: (sql, params) => {
      calls.push({ kind: "query", sql, params });
      return opts.failOn !== undefined && sql.includes(opts.failOn)
        ? Effect.fail(new FakeExecError(opts.failWith ?? { message: "exec failed" }))
        : Effect.succeed([]);
    },
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

const executedSql = (
  calls: ReadonlyArray<{
    readonly kind: "exec" | "batch" | "query";
    readonly sql: string;
    readonly statements?: ReadonlyArray<LegacyDbBatchStatement>;
  }>,
): ReadonlyArray<string> =>
  calls.flatMap((call) =>
    call.kind === "exec"
      ? [call.sql]
      : call.kind === "batch"
        ? (call.statements ?? []).map(({ sql }) => sql)
        : [],
  );

const run = (
  session: LegacyDbSession,
  migrationPath: string,
): Effect.Effect<void, TestError | LegacyDbConnectError> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyApplyMigrationFile(
      session,
      fs,
      path,
      migrationPath,
      (message) => new TestError({ message }),
    );
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyApplyMigrationFile", () => {
  it.effect(
    "creates the history table, then runs the statements + history insert in a transaction",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
      const file = join(dir, "20240101120000_add_col.sql");
      writeFileSync(file, "ALTER TABLE a ADD COLUMN b int;\nCREATE INDEX i ON a(b);");
      const { session, calls } = fakeSession();
      return run(session, file).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const execs = executedSql(calls);
            expect(execs).toContain("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
            expect(execs).toContain("RESET ALL");
            // The history-table setup scopes lock_timeout to its own transaction
            // (SET LOCAL), so it reverts on COMMIT and never leaks into the migration's
            // statements — matching Go's implicit ExecBatch transaction.
            // RESET ALL runs FIRST — before the history-table setup transaction — so a
            // session default leaked by a prior migration is cleared before this DDL.
            expect(execs[0]).toBe("RESET ALL");
            const firstBegin = execs.indexOf("BEGIN");
            const setupCommit = execs.indexOf("COMMIT");
            const setLocal = execs.indexOf("SET LOCAL lock_timeout = '4s'");
            expect(firstBegin).toBe(1);
            expect(setLocal).toBeGreaterThan(firstBegin);
            expect(setLocal).toBeLessThan(setupCommit);
            // The migration's statements and history insert share one implicitly
            // transactional extended-protocol batch.
            const migrationBatch = calls.find((call) => call.kind === "batch");
            expect(migrationBatch?.statements?.map(({ sql }) => sql)).toEqual([
              "ALTER TABLE a ADD COLUMN b int",
              "CREATE INDEX i ON a(b)",
              expect.stringContaining("supabase_migrations.schema_migrations"),
            ]);
            // History insert carries version, name, and the statements array.
            const insert = migrationBatch?.statements?.at(-1);
            expect(insert?.sql).toContain("supabase_migrations.schema_migrations");
            expect(insert?.params).toEqual([
              "20240101120000",
              "add_col",
              ["ALTER TABLE a ADD COLUMN b int", "CREATE INDEX i ON a(b)"],
            ]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("restores platform search_path after RESET ALL on a stepped-down session", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_add_col.sql");
    writeFileSync(file, "ALTER TABLE a ADD COLUMN b int;");
    const searchPath = `SET search_path TO "$user", public, extensions`;
    const { session, calls } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      restoreSearchPathSql: searchPath,
    });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = executedSql(calls);
          expect(execs[0]).toBe("RESET ALL");
          expect(execs[1]).toBe(searchPath);
          expect(execs.indexOf(searchPath)).toBeLessThan(execs.indexOf("BEGIN"));
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("records a versioned empty migration in one batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_empty.sql");
    writeFileSync(file, "");
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches).toHaveLength(1);
          expect(batches[0]?.statements).toEqual([
            {
              sql: expect.stringContaining("supabase_migrations.schema_migrations"),
              params: ["20240101120000", "empty", []],
            },
          ]);
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("rolls back and maps the error when a statement fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_boom.sql");
    writeFileSync(file, "ALTER TABLE a ADD COLUMN b int;");
    const { session, calls } = fakeSession({ failOn: "ADD COLUMN b int" });
    return run(session, file).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.filter((call) => call.kind === "batch")).toHaveLength(1);
          // Go's ExecBatch appends the failing statement number + text for context.
          if (Exit.isFailure(exit)) {
            const msg = JSON.stringify(exit.cause);
            expect(msg).toContain("At statement: 0");
            expect(msg).toContain("ALTER TABLE a ADD COLUMN b int");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("sends a large compatible migration in one batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_many.sql");
    const statements = Array.from({ length: 10_000 }, (_, index) => `SELECT ${index + 1}`);
    writeFileSync(file, `${statements.join(";\n")};`);
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches).toHaveLength(1);
          expect(batches[0]?.statements).toHaveLength(statements.length + 1);
          expect(batches[0]?.statements?.slice(0, -1).map(({ sql }) => sql)).toEqual(statements);
          expect(calls.some((call) => call.kind === "exec" && statements.includes(call.sql))).toBe(
            false,
          );
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps the global error index after an incompatible-statement flush", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail_after_vacuum.sql");
    writeFileSync(file, "SELECT 1;\nVACUUM;\nSELECT missing_column;\nSELECT 4;");
    const { session } = fakeSession({ failOn: "missing_column" });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 2");
          expect(error.message).toContain("SELECT missing_column");
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("defaults a deferred batch failure to the migration history statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_deferred.sql");
    writeFileSync(file, "SELECT 1;");
    const { session } = fakeSession({ failAfterBatch: true });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 2");
          expect(error.message).toContain("INSERT INTO supabase_migrations.schema_migrations");
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "wraps a read failure with Go's parse-file error text (Go NewMigrationFromFile parity)",
    () => {
      // `NewMigrationFromFile`/`parseFile` wraps the open failure as
      // `"failed to open migration file: %w"` before
      // `ApplyMigrations`/`applySchemaFiles` ever get a chance to attach a
      // `CmdSuggestion` — a read failure here must carry the same prefix, not the bare
      // platform error text.
      const dir = mkdtempSync(join(tmpdir(), "legacy-apply-read-fail-"));
      const missingFile = join(dir, "20240101120000_missing.sql");
      const { session } = fakeSession();
      return run(session, missingFile).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const msg = JSON.stringify(exit.cause);
              expect(msg).toContain("failed to open migration file: ");
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("runs a pipeline-incompatible statement outside the surrounding transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_add_index.sql");
    writeFileSync(
      file,
      "create table a (id int);\nCREATE INDEX CONCURRENTLY a_idx ON a(id);\nALTER TABLE a ENABLE ROW LEVEL SECURITY;",
    );
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = executedSql(calls);
          const concurrently = "CREATE INDEX CONCURRENTLY a_idx ON a(id)";
          expect(execs).toContain(concurrently);
          // The CONCURRENTLY statement must not run inside an implicit batch
          // transaction, so the compatible statements are flushed on each side.
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches).toHaveLength(2);
          expect(batches[0]?.statements?.map(({ sql }) => sql)).toEqual([
            "create table a (id int)",
          ]);
          expect(batches[1]?.statements?.map(({ sql }) => sql)).toEqual([
            "ALTER TABLE a ENABLE ROW LEVEL SECURITY",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          // The migration is still recorded once every statement succeeds.
          const insert = batches[1]?.statements?.at(-1);
          expect(insert?.params?.[0]).toBe("20240101120000");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors pg-delta's file-level no-transaction directive", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_drop_subscription.sql");
    writeFileSync(
      file,
      "-- pg-delta: transaction=false\n" +
        "SET check_function_bodies = off;\n" +
        "DROP SUBSCRIPTION app_events;\n" +
        "RESET ALL;",
    );
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = calls.filter((call) => call.kind === "exec").map((call) => call.sql);
          const setupCommit = execs.indexOf("COMMIT");
          const firstStatement = "-- pg-delta: transaction=false\nSET check_function_bodies = off";
          const set = execs.indexOf(firstStatement);
          const action = execs.indexOf("DROP SUBSCRIPTION app_events");
          const cleanup = execs.lastIndexOf("RESET ALL");

          // The history-table setup owns the only CLI transaction. Pg-delta's
          // preamble, action, and cleanup then run sequentially on this session.
          expect(execs.filter((sql) => sql === "BEGIN")).toHaveLength(1);
          expect(execs.filter((sql) => sql === "COMMIT")).toHaveLength(1);
          expect(set).toBeGreaterThan(setupCommit);
          expect(action).toBeGreaterThan(set);
          expect(cleanup).toBeGreaterThan(action);

          const history = calls.filter((call) => call.kind === "query");
          expect(history).toHaveLength(1);
          expect(history[0]?.params).toEqual([
            "20240101120000",
            "drop_subscription",
            [firstStatement, "DROP SUBSCRIPTION app_events", "RESET ALL"],
          ]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("resets the session and omits history when a no-transaction migration fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_drop_subscription.sql");
    writeFileSync(
      file,
      "-- pg-delta: transaction=false\n" +
        "SET check_function_bodies = off;\n" +
        "DROP SUBSCRIPTION app_events;\n" +
        "RESET ALL;",
    );
    const { session, calls } = fakeSession({ failOn: "DROP SUBSCRIPTION" });
    return run(session, file).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          const execs = calls.filter((call) => call.kind === "exec").map((call) => call.sql);
          expect(execs.at(-1)).toBe("RESET ALL");
          expect(calls.some((call) => call.kind === "query")).toBe(false);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("At statement: 1");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports a pipeline-incompatible statement failure with its statement index", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_add_index.sql");
    writeFileSync(file, "create table a (id int);\nCREATE INDEX CONCURRENTLY a_idx ON a(id);");
    const { session, calls } = fakeSession({ failOn: "CONCURRENTLY" });
    return run(session, file).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const msg = JSON.stringify(exit.cause);
            // Index 1: the leading `create table a` (index 0) committed in its own batch first.
            expect(msg).toContain("At statement: 1");
            expect(msg).toContain("CREATE INDEX CONCURRENTLY a_idx ON a(id)");
          }
          // The migration version is not recorded when a statement fails.
          expect(
            executedSql(calls).some((sql) =>
              sql.includes("INSERT INTO supabase_migrations.schema_migrations"),
            ),
          ).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("preserves authored transaction boundaries and records history afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_authored.sql");
    writeFileSync(file, "BEGIN;\nSET LOCAL check_function_bodies = off;\nCOMMIT;");
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = calls.filter((call) => call.kind === "exec").map((call) => call.sql);
          // One BEGIN/COMMIT belongs to history-table setup; the other pair is
          // exactly the authored boundary, with no nested migration wrapper.
          expect(execs.filter((sql) => sql === "BEGIN")).toHaveLength(2);
          expect(execs.filter((sql) => sql === "COMMIT")).toHaveLength(2);
          expect(execs).toContain("SET LOCAL check_function_bodies = off");
          const history = calls.filter((call) => call.kind === "query");
          expect(history).toHaveLength(1);
          expect(history[0]?.params?.[0]).toBe("20240101120000");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps savepoint rollback inside the managed migration transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_savepoint.sql");
    writeFileSync(
      file,
      "SAVEPOINT before_change;\n" +
        "UPDATE accounts SET active = false;\n" +
        "ROLLBACK TO SAVEPOINT before_change;\n" +
        "SELECT 1;",
    );
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // `ROLLBACK TO SAVEPOINT` is not an authored boundary, so the file keeps the
          // CLI-managed transaction — which is the single implicitly transactional
          // batch (one Sync), carrying the history insert as its last statement.
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches).toHaveLength(1);
          expect(batches[0]?.statements?.map(({ sql }) => sql)).toEqual([
            "SAVEPOINT before_change",
            "UPDATE accounts SET active = false",
            "ROLLBACK TO SAVEPOINT before_change",
            "SELECT 1",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          // No standalone history insert: it rides the same batch as the statements.
          expect(calls.filter((call) => call.kind === "query")).toHaveLength(0);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not record history when an authored transaction fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_authored.sql");
    writeFileSync(file, "BEGIN;\nCREATE TABLE broken (;\nCOMMIT;");
    const { session, calls } = fakeSession({ failOn: "CREATE TABLE broken" });
    return run(session, file).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.some((call) => call.kind === "query")).toBe(false);
          expect(calls.some((call) => call.kind === "exec" && call.sql === "ROLLBACK")).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  // Passwordless remote sessions step down from the temp login role via
  // `SET SESSION ROLE postgres`; a migration's own `RESET ROLE` reverts to the
  // login role, which used to fail the history insert with 42501 (supabase/cli#6236).
  it.effect(
    "re-asserts the stepped-down role between the statements and the history insert",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
      const file = join(dir, "20240101120000_reset_role.sql");
      writeFileSync(file, "set role repro_writer;\ncreate table t (id int);\nreset role;");
      const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
      return run(session, file).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // The restore is injected right after the trailing RESET ROLE (the
            // end-of-file restore dedupes away), so the insert runs as postgres —
            // and the committed session ends role-clean for the next file.
            const batch = calls.find((call) => call.kind === "batch");
            expect(batch?.statements?.map(({ sql }) => sql)).toEqual([
              "set role repro_writer",
              "create table t (id int)",
              "reset role",
              "SET SESSION ROLE postgres",
              expect.stringContaining("supabase_migrations.schema_migrations"),
            ]);
            // The ledger row records only the file's own statements.
            expect(batch?.statements?.at(-1)?.params?.[2]).toEqual([
              "set role repro_writer",
              "create table t (id int)",
              "reset role",
            ]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("never re-asserts a role on sessions that did not step down", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_reset_role.sql");
    writeFileSync(file, "reset role;");
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(executedSql(calls).some((sql) => sql.includes("SET SESSION ROLE"))).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("re-asserts the stepped-down role before recording an authored transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_authored.sql");
    writeFileSync(file, "BEGIN;\nreset role;\nCOMMIT;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const lastRestore = calls.findLastIndex(
            (call) => call.kind === "exec" && call.sql === "SET SESSION ROLE postgres",
          );
          const authoredCommit = calls.findLastIndex(
            (call) => call.kind === "exec" && call.sql === "COMMIT",
          );
          const history = calls.findIndex((call) => call.kind === "query");
          expect(lastRestore).toBeGreaterThan(authoredCommit);
          expect(history).toBeGreaterThan(lastRestore);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the history insert's statement index when the role restore precedes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, "SELECT 1;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failOn: "INSERT INTO supabase_migrations",
      failWith: {
        message: "ERROR: permission denied for schema supabase_migrations (SQLSTATE 42501)",
        code: "42501",
      },
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("permission denied for schema supabase_migrations");
          // The CLI-internal restore op must not shift Go's `At statement: N`.
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("INSERT INTO supabase_migrations.schema_migrations");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps a mid-batch failure's statement index when a restore op is appended", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, "SELECT 1;\nSELECT bad_col;\nSELECT 3;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failOn: "bad_col",
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("SELECT bad_col");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the deferred-failure index when a restore op is appended", () => {
    // Mirrors "defaults a deferred batch failure to the migration history
    // statement": the restore op between the statements and the insert must not
    // shift the deferred (post-Sync) index either.
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_deferred.sql");
    writeFileSync(file, "SELECT 1;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failAfterBatch: true,
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 2");
          expect(error.message).toContain("INSERT INTO supabase_migrations.schema_migrations");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports the restore op's own failure with the history step's index", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, "SELECT 1;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failOn: "SET SESSION ROLE",
      failWith: {
        message: 'ERROR: permission denied to set role "postgres" (SQLSTATE 42501)',
        code: "42501",
      },
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("SET SESSION ROLE postgres");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the insert index when the final batch holds only the trailing ops", () => {
    // A trailing CONCURRENTLY statement empties `pending`, so the final batch is
    // just [restore, insert] — the index math must still report the file's count.
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, "SELECT 1;\nCREATE INDEX CONCURRENTLY i ON a(id);");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failOn: "INSERT INTO supabase_migrations",
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 2");
          expect(error.message).toContain("INSERT INTO supabase_migrations.schema_migrations");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("restores postgres immediately after a mid-file RESET ROLE, silently", () => {
    // Statements after the reset now run as postgres again (avallete's #6246
    // review), so the old drift WARN is gone — there is no drift left to surface.
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_reset_role.sql");
    writeFileSync(file, "set role r;\nreset role;\nselect 1;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    const out = mockOutput({ format: "text" });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const batch = calls.find((call) => call.kind === "batch");
          expect(batch?.statements?.map(({ sql }) => sql)).toEqual([
            "set role r",
            "reset role",
            "SET SESSION ROLE postgres",
            "select 1",
            "SET SESSION ROLE postgres",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          expect(batch?.statements?.at(-1)?.params?.[2]).toEqual([
            "set role r",
            "reset role",
            "select 1",
          ]);
          expect(out.stderrText).not.toContain("WARN:");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(out.layer),
    );
  });

  it.effect("restores postgres after every static role-revert spelling", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_role_none.sql");
    writeFileSync(
      file,
      "set role a;\nset role none;\nset role to none;\nreset session authorization;\nset role = default;",
    );
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const batch = calls.find((call) => call.kind === "batch");
          expect(batch?.statements?.map(({ sql }) => sql)).toEqual([
            "set role a",
            "set role none",
            "SET SESSION ROLE postgres",
            "set role to none",
            "SET SESSION ROLE postgres",
            "reset session authorization",
            "SET SESSION ROLE postgres",
            "set role = default",
            "SET SESSION ROLE postgres",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("emits exactly one restore when a no-transaction file ends in a revert", () => {
    // Sequential path: the injected restore after the trailing `reset role`
    // makes the end-of-file restore redundant, so it must dedupe away.
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_seq_reset.sql");
    writeFileSync(file, "-- pg-delta: transaction=false\nset role r;\nreset role;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = calls.filter((call) => call.kind === "exec").map((call) => call.sql);
          expect(execs.filter((sql) => sql === "SET SESSION ROLE postgres")).toHaveLength(1);
          expect(execs[execs.indexOf("reset role") + 1]).toBe("SET SESSION ROLE postgres");
          expect(calls.filter((call) => call.kind === "query")).toHaveLength(1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the deferred-failure index when mid-file restores were injected", () => {
    // The `injectedBefore[raw] ?? injected` fallback only matters when the
    // deferred (post-Sync) index lands past the ops array AND injections exist.
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_deferred.sql");
    writeFileSync(file, "set role r;\nreset role;\nselect 1;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failAfterBatch: true,
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 4");
          expect(error.message).toContain("INSERT INTO supabase_migrations.schema_migrations");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("injects into intermediate flushes so standalone statements run as postgres", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_concurrent.sql");
    writeFileSync(file, "reset role;\nCREATE INDEX CONCURRENTLY i ON a(id);\nselect 2;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches[0]?.statements?.map(({ sql }) => sql)).toEqual([
            "reset role",
            "SET SESSION ROLE postgres",
          ]);
          expect(batches[1]?.statements?.map(({ sql }) => sql)).toEqual([
            "select 2",
            "SET SESSION ROLE postgres",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports a mid-file restore's own failure at its host statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, "set role r;\nreset role;\nselect 1;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failOn: "SET SESSION ROLE",
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          // The injected op inherits `reset role`'s index and shows the SQL that
          // actually failed, so debugging lands on the right line of the file.
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("SET SESSION ROLE postgres");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps statement numbering across an injected mid-file restore", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, "set role r;\nreset role;\nselect bad;");
    const { session } = fakeSession({
      restoreRoleSql: "SET SESSION ROLE postgres",
      failOn: "select bad",
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 2");
          expect(error.message).toContain("select bad");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("legacyHasTransactionControl", () => {
  it("recognizes authored boundaries after comments without matching routine bodies", () => {
    expect(legacyHasTransactionControl("-- authored\nBEGIN")).toBe(true);
    expect(legacyHasTransactionControl("START TRANSACTION ISOLATION LEVEL SERIALIZABLE")).toBe(
      true,
    );
    expect(
      legacyHasTransactionControl(
        "CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql",
      ),
    ).toBe(false);
  });

  it("distinguishes transaction rollback from savepoint rollback", () => {
    for (const sql of ["ROLLBACK", "ROLLBACK WORK", "ROLLBACK TRANSACTION"]) {
      expect(legacyHasTransactionControl(sql)).toBe(true);
    }
    for (const sql of [
      "ROLLBACK TO before_change",
      "ROLLBACK TO SAVEPOINT before_change",
      "ROLLBACK WORK TO SAVEPOINT before_change",
      "ROLLBACK TRANSACTION TO before_change",
    ]) {
      expect(legacyHasTransactionControl(sql)).toBe(false);
    }
  });
});

describe("migration failure rendering (Go ExecBatch parity)", () => {
  // Byte-exact ports of `(*MigrationFile).ExecBatch` error layout:
  // `<pg error>\n[Detail]\n[42704 hint]\n`
  // `At statement: <i>\n<caret-marked statement>`.
  const failing = (
    sql: string,
    failWith: { message: string; code?: string; detail?: string; position?: number },
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-apply-"));
    const file = join(dir, "20240101120000_fail.sql");
    writeFileSync(file, `${sql};`);
    const { session } = fakeSession({ failOn: sql, failWith });
    return run(session, file).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  };

  it.effect("marks the error position with a caret under the failing statement", () => {
    const stat = "CREATE TABLE test (path ltree NOT NULL)";
    return failing(stat, {
      message: 'ERROR: type "ltree" does not exist (SQLSTATE 42704)',
      code: "42704",
      position: 25,
    }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).toBe(
            'ERROR: type "ltree" does not exist (SQLSTATE 42704)\n' +
              "\n" +
              "Hint: This type may be defined in a schema that's not in your search_path.\n" +
              "      Use schema-qualified type references to avoid this error:\n" +
              "        CREATE TABLE example (col extensions.ltree);\n" +
              "      Learn more: supabase migration new --help\n" +
              "At statement: 0\n" +
              "CREATE TABLE test (path ltree NOT NULL)\n" +
              "                        ^",
          );
        }),
      ),
    );
  });

  it.effect("renders the server Detail line before the statement context", () => {
    const stat = "INSERT INTO child VALUES (1)";
    return failing(stat, {
      message:
        'ERROR: insert or update on table "child" violates foreign key constraint "child_parent_id_fkey" (SQLSTATE 23503)',
      code: "23503",
      detail: 'Key (parent_id)=(1) is not present in table "parent".',
    }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).toBe(
            'ERROR: insert or update on table "child" violates foreign key constraint "child_parent_id_fkey" (SQLSTATE 23503)\n' +
              'Key (parent_id)=(1) is not present in table "parent".\n' +
              "At statement: 0\n" +
              "INSERT INTO child VALUES (1)",
          );
        }),
      ),
    );
  });

  it.effect("skips the hint when the SQLSTATE is not 42704", () => {
    // Go gates the hint on `pgErr.Code == "42704"` in addition to the message
    // pattern — a matching message under a different code must stay hint-free.
    const stat = "CREATE TABLE test (path ltree NOT NULL)";
    return failing(stat, {
      message: 'ERROR: type "ltree" does not exist (SQLSTATE 42P01)',
      code: "42P01",
    }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).toBe(
            'ERROR: type "ltree" does not exist (SQLSTATE 42P01)\n' +
              "At statement: 0\n" +
              "CREATE TABLE test (path ltree NOT NULL)",
          );
        }),
      ),
    );
  });

  it.effect("hints search_path when an unqualified function is missing", () => {
    const stat = "SELECT gen_random_bytes(16)";
    return failing(stat, {
      message: "ERROR: function gen_random_bytes(integer) does not exist (SQLSTATE 42883)",
      code: "42883",
    }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).toContain(
            "Hint: This function may be defined in a schema that's not in your search_path.",
          );
          expect(message).toContain("extensions.gen_random_bytes");
          expect(message).toContain(`SET search_path TO "$user", public, extensions`);
        }),
      ),
    );
  });

  it.effect("skips the function hint when the name is already schema-qualified", () => {
    const stat = "SELECT extensions.gen_random_bytes(16)";
    return failing(stat, {
      message:
        "ERROR: function extensions.gen_random_bytes(integer) does not exist (SQLSTATE 42883)",
      code: "42883",
    }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).not.toContain("Hint: This function may be defined");
        }),
      ),
    );
  });

  it.effect("skips the 42704 hint when the type is already schema-qualified", () => {
    const stat = "CREATE TABLE test (path extensions.ltree NOT NULL)";
    return failing(stat, {
      message: 'ERROR: type "extensions.ltree" does not exist (SQLSTATE 42704)',
      code: "42704",
    }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).toBe(
            'ERROR: type "extensions.ltree" does not exist (SQLSTATE 42704)\n' +
              "At statement: 0\n" +
              "CREATE TABLE test (path extensions.ltree NOT NULL)",
          );
        }),
      ),
    );
  });

  it.effect("keeps the plain layout for errors without position or detail", () => {
    const stat = "ALTER TABLE a ADD COLUMN b int";
    return failing(stat, { message: "exec failed" }).pipe(
      Effect.tap((message) =>
        Effect.sync(() => {
          expect(message).toBe("exec failed\nAt statement: 0\nALTER TABLE a ADD COLUMN b int");
        }),
      ),
    );
  });
});

describe("legacyMarkError", () => {
  // Every expectation below is pinned against `markError` output,
  // captured by running the Go function
  // directly on the same inputs.
  it("places the caret under a mid-statement position", () => {
    expect(legacyMarkError("create table t (col ltree)", 21)).toBe(
      "create table t (col ltree)\n                    ^",
    );
  });

  it("returns the statement unchanged for position 0 (absent)", () => {
    expect(legacyMarkError("create table t (col ltree)", 0)).toBe("create table t (col ltree)");
  });

  it("returns the statement unchanged when the position is past the end", () => {
    expect(legacyMarkError("abc", 99)).toBe("abc");
  });

  it("returns the statement unchanged when the position lands on a line break", () => {
    expect(legacyMarkError("ab\ncd", 3)).toBe("ab\ncd");
  });

  it("marks a position on a later line and drops the lines after it", () => {
    expect(legacyMarkError("create table t (\n  col ltree\n)", 20)).toBe(
      "create table t (\n  col ltree\n  ^",
    );
    expect(legacyMarkError("l1\nl2\nl3\nl4", 4)).toBe("l1\nl2\n^");
  });

  it("places the caret under the last character when the position equals the line length", () => {
    expect(legacyMarkError("abcde", 5)).toBe("abcde\n    ^");
  });

  it("consumes the position in UTF-8 bytes like Go, not characters", () => {
    // "héllo" is 5 characters but 6 bytes; Go decrements the position by the
    // BYTE length + 1 per line, so position 8 lands on column 1 of "world"
    // (character counting would land on column 2). Verified against Go.
    expect(legacyMarkError("héllo\nworld", 8)).toBe("héllo\nworld\n^");
    expect(legacyMarkError("sélect 1", 3)).toBe("sélect 1\n  ^");
  });
});

describe("legacyIsPipelineIncompatible", () => {
  // Mirrors `TestIsPipelineIncompatible` (`pkg/migration/file_test.go`, supabase/cli#5156).
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    [
      "create index concurrently",
      "CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
      true,
    ],
    [
      "create unique index concurrently",
      "CREATE UNIQUE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
      true,
    ],
    [
      "create index concurrently after comments",
      "-- cannot run in a transaction\n/* generated */\nCREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)",
      true,
    ],
    ["drop index concurrently", "DROP INDEX CONCURRENTLY public.widgets_id_idx", true],
    [
      "drop index concurrently if exists",
      "drop index concurrently if exists api.idx_rx_orders_clinic_id",
      true,
    ],
    ["reindex table concurrently", "REINDEX TABLE CONCURRENTLY public.widgets", true],
    [
      "reindex with options concurrently",
      "REINDEX (VERBOSE) INDEX CONCURRENTLY widgets_id_idx",
      true,
    ],
    ["vacuum bare", "VACUUM", true],
    ["vacuum with options", "VACUUM (FULL, ANALYZE) public.widgets", true],
    ["alter system", "ALTER SYSTEM SET wal_level = 'logical'", true],
    ["cluster", "CLUSTER public.widgets USING widgets_id_idx", true],
    [
      "lower-case create index concurrently",
      "create index concurrently widgets_id_idx on public.widgets(id)",
      true,
    ],
    ["leading whitespace before concurrently", "   CREATE INDEX CONCURRENTLY a_idx ON a(id)", true],
    ["bom before vacuum", "\uFEFFVACUUM", true],
    // Negatives — compatible statements that must keep running inside the batch transaction.
    ["plain create index", "CREATE INDEX widgets_id_idx ON public.widgets(id)", false],
    ["plain drop index", "DROP INDEX IF EXISTS public.widgets_id_idx", false],
    [
      "concurrently in string literal",
      "SELECT 'CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)'",
      false,
    ],
    [
      "concurrently in leading comment only",
      "-- CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets(id)\nSELECT 1",
      false,
    ],
    ["line comment without trailing newline", "-- CREATE INDEX CONCURRENTLY a_idx ON a(id)", false],
    ["unclosed block comment", "/* unclosed CREATE INDEX CONCURRENTLY a_idx ON a(id)", false],
    ["create table", "create table public.widgets(id bigint primary key)", false],
    ["reindex without concurrently", "REINDEX TABLE public.widgets", false],
    ["vacuum-prefixed identifier", "VACUUMING analytics", false],
    ["concurrently as a column name", "CREATE TABLE t (concurrently int)", false],
    ["insert", "INSERT INTO public.widgets VALUES (1)", false],
    ["cluster-prefixed identifier", "CLUSTERED", false],
  ];

  it.each(cases)("%s", (_name, sql, want) => {
    expect(legacyIsPipelineIncompatible(sql)).toBe(want);
  });
});

describe("legacySeedGlobals", () => {
  it.effect("runs the globals file WITHOUT RESET ALL and without a history insert", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-globals-"));
    const file = join(dir, "roles.sql");
    writeFileSync(file, "CREATE ROLE my_role;");
    const { session, calls } = fakeSession();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySeedGlobals(session, fs, path, [file], (message) => new TestError({ message }));
      const execs = executedSql(calls);
      // Go's SeedGlobals calls ExecBatch directly — no RESET ALL (that's only the
      // migration-apply path) and no schema-migrations history insert.
      expect(execs).not.toContain("RESET ALL");
      expect(execs).toContain("CREATE ROLE my_role");
      expect(
        execs.some((sql) => sql.includes("INSERT INTO supabase_migrations.schema_migrations")),
      ).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(BunServices.layer),
    );
  });

  it.effect("leaves a stepped-down session role-clean after a globals file", () => {
    // Globals run before the vault upsert and the history-table DDL on the same
    // session, so a `reset role` here must not leak the login role into them.
    const dir = mkdtempSync(join(tmpdir(), "legacy-globals-"));
    const file = join(dir, "roles.sql");
    writeFileSync(file, "CREATE ROLE my_role;\nset role my_role;\nreset role;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySeedGlobals(session, fs, path, [file], (message) => new TestError({ message }));
      const batch = calls.find((call) => call.kind === "batch");
      expect(batch?.statements?.at(-1)?.sql).toBe("SET SESSION ROLE postgres");
      expect(
        executedSql(calls).some((sql) => sql.includes("supabase_migrations.schema_migrations")),
      ).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(BunServices.layer),
    );
  });
});

describe("legacyApplySchemaFiles", () => {
  it.effect(
    "reports a read failure with the workdir-relative path, not the absolute path used to read it (Go open supabase/... parity)",
    () => {
      // Go opens the workdir-relative `fp` from `schema_paths` directly (its process
      // cwd is always the workdir, `ChangeWorkDir`), so a read failure reports
      // `open supabase/unreadable.sql: ...`. This module never `process.chdir`s, so
      // the real read needs an absolute path — but the wrapped read-failure message
      // must still show the relative `supabase/...` form, not that absolute path. An
      // unreadable file (a real permission failure, not a missing-path one) reproduces
      // a genuine read failure while still passing the glob's own stat/type check —
      // `stat` only needs directory execute permission, not read permission on the
      // file itself, so this still resolves as a `"File"` match, unlike a directory
      // (which the glob would instead expand via `legacyWalkSqlFiles`).
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-read-fail-"));
      const file = join(dir, "supabase", "unreadable.sql");
      mkdirSync(join(dir, "supabase"), { recursive: true });
      writeFileSync(file, "select 1;");
      chmodSync(file, 0o000);
      const { session } = fakeSession();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/unreadable.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("failed to open migration file: ");
          expect(msg).toContain("supabase/unreadable.sql");
          expect(msg).not.toContain(dir);
        }
        chmodSync(file, 0o644);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "rejects an oversized statement when SUPABASE_SCANNER_BUFFER_SIZE is configured (Go bufio.Scanner: token too long parity)",
    () => {
      // `parser.Split` only enforces
      // `SUPABASE_SCANNER_BUFFER_SIZE` when it's explicitly set — `parseFile`
      // otherwise auto-grows the scanner to the real file's byte length, so the
      // DEFAULT path can never hit `bufio.ErrTooLong`. With it set below a single
      // statement's raw byte length, this fails with `bufio.Scanner: token too long`
      // instead of silently applying the oversized statement — verified empirically
      // (a `parser.SplitAndTrim` scratch probe).
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      // A single, un-splittable statement whose raw text exceeds the 4096-byte floor
      // (`bufio.Scanner` starts at that size regardless of the configured limit).
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "100b";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
          expect(msg).toContain("After statement 1: SELECT 1;");
          expect(msg).toContain("Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB");
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "reports the last scanned RAW token in the too-long error even when it trimmed to empty (Go scanner.Text() parity, review CLI-1958)",
    () => {
      // `token = scanner.Text()` runs on EVERY
      // successful `Scan()`, unconditionally — BEFORE the `len(trim) > 0` gate that
      // decides whether to append to `stats`. So when a statement trims to empty
      // (a lone ";") immediately before an oversized one, `bufio.ErrTooLong`
      // message still reports that lone ";" as the last-scanned text, not a blank
      // token — `len(stats)` (this port's `emitted`) stays gated on non-empty trim,
      // but the reported RAW text must not share that gate.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-empty-token-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `;\nSELECT '${"a".repeat(5000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "100b";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
          // 0 statements were EMITTED (the lone ";" trimmed to empty and was never
          // appended), but the last scanned RAW token (";") must still show — not a
          // blank token, which a trim-gated tracker would wrongly report instead.
          expect(msg).toContain("After statement 0: ;");
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "applies an oversized statement fine when SUPABASE_SCANNER_BUFFER_SIZE is unset (Go's default auto-grows to file size)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-default-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT '${"a".repeat(5000)}';\n`);
      const { session, calls } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        );
        expect(executedSql(calls).some((sql) => sql.startsWith("SELECT 'a"))).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous !== undefined) process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "falls back to Go's hardcoded default cap when SUPABASE_SCANNER_BUFFER_SIZE is set but unparseable (viper parity, not '5M' == 5MiB)",
    () => {
      // Verified empirically: a bare multiplier suffix with NO trailing "b"/"B" (e.g. "5M")
      // is NOT 5 MiB in real Go — `parseSizeInBytes` only recognizes a multiplier when
      // the string's LAST character is literally "b"/"B", so "5M" never strips a
      // suffix and `cast.ToInt("5M")` fails whole, yielding 0. `viper.IsSet` is still
      // true (the var IS present), so `parseFile`'s file-size auto-growth never runs —
      // `parser.Split` falls back to its OWN hardcoded default cap
      // (`MaxScannerCapacity`, 256KiB), not to "no limit" and not to a tiny 5-byte
      // limit either. A statement past that hardcoded default must still fail.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-garbage-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(300_000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "5M";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
          // 256KiB (`parser.MaxScannerCapacity` default), not "5MB" and not ~0KB.
          expect(msg).toContain(
            "Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is 256KB)",
          );
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "accepts a hex-literal SUPABASE_SCANNER_BUFFER_SIZE (Go strconv.ParseInt base-0 parity, review CLI-1958)",
    () => {
      // `viper.GetSizeInBytes` → `cast.ToInt` → `strconv.ParseInt(s, 0, 0)` parses
      // with base 0, so a `0x`-prefixed literal is a valid byte count in real Go:
      // "0x1400" is 5120 (5KiB) — verified empirically against vendored
      // `viper@v1.21.0` (`viper.GetSizeInBytes("SCANNER_BUFFER_SIZE")` with the env
      // var set to "0x1400" returns 5120). A decimal-only parser would reject this
      // string outright and silently fall back to the 256KiB default instead, so a
      // statement between 5120 and 262144 bytes would apply in TS but Go would
      // already have failed with "bufio.Scanner: token too long" at 5121 bytes.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-hex-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "0x1400";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
          // 5KiB (0x1400 bytes), not the 256KiB hardcoded fallback a decimal-only
          // parser would have silently used instead.
          expect(msg).toContain(
            "Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is 5KB)",
          );
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "accepts underscore digit separators in a decimal SUPABASE_SCANNER_BUFFER_SIZE (Go strconv.ParseInt base-0 underscore-literal parity, review CLI-1958)",
    () => {
      // Go's base-0 integer grammar (`go.dev/ref/spec#Integer_literals`, reproduced
      // by `strconv.ParseInt`) permits a single `_` between digits: "5_120" is the
      // same 5120 (5KiB) byte count as the hex-literal test above's "0x1400" —
      // verified empirically against the real `strconv.ParseInt("5_120", 0, 64)`.
      // A parser that rejects underscores outright would silently fall back to the
      // 256KiB default instead, so a statement between 5120 and 262144 bytes would
      // apply in TS but Go would already have failed with "bufio.Scanner: token too
      // long" at 5121 bytes.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-underscore-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "5_120";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
          // 5KiB (5_120 bytes), not the 256KiB hardcoded fallback an
          // underscore-rejecting parser would have silently used instead.
          expect(msg).toContain(
            "Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is 5KB)",
          );
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "rejects an invalid underscore placement in SUPABASE_SCANNER_BUFFER_SIZE, unlike a valid digit separator (Go strconv.ParseInt underscore-grammar parity, review CLI-1958)",
    () => {
      // Go only permits a SINGLE underscore immediately after a base prefix or
      // between two digits — never leading a plain (no-prefix) decimal literal,
      // never doubled, never trailing. "_5120" (leading underscore, no prefix) is
      // invalid in real Go (`strconv.ParseInt("_5120", 0, 64)` errors), so it falls
      // back to the same 256KiB default as a genuinely unset/unparseable value —
      // verified empirically against the real Go `strconv.ParseInt`.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-bad-underscore-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "_5120";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        // The 5116-byte statement fits comfortably under the 256KiB default
        // fallback, so an invalid underscore placement must NOT fail the apply.
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "falls back to Go's hardcoded default cap when SUPABASE_SCANNER_BUFFER_SIZE overflows Go's signed int range (strconv.ParseInt/cast.ToInt range-error parity, review CLI-1958)",
    () => {
      // "9223372036854775808" is one more than `math.MaxInt64`. Go's
      // `strconv.ParseInt(s, 0, 0)` rejects it with a range error, and `cast.ToInt`
      // discards ANY `parseFn` error —
      // range or syntax — returning exactly `0`, never the huge (if imprecise)
      // magnitude `Number.parseInt` would otherwise accept. `viper.IsSet` is still
      // true, so this falls back to the 256KiB hardcoded default, same as a
      // genuinely unparseable value ("5M" above) — NOT to "no limit". Verified
      // empirically against the pinned `spf13/cast@v1.10.0`
      // (`cast.ToInt("9223372036854775808")` → `0`).
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-int64-overflow-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(300_000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "9223372036854775808";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
          // 256KiB (Go's hardcoded default), not "no limit" — a treat-as-unbounded
          // bug would let this 300_000-byte statement apply successfully instead.
          expect(msg).toContain(
            "Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is 256KB)",
          );
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "still accepts the exact int64 boundary magnitudes for SUPABASE_SCANNER_BUFFER_SIZE (Go strconv.ParseInt range-boundary parity, review CLI-1958)",
    () => {
      // `math.MaxInt64` itself ("9223372036854775807", one less than the overflow
      // test above) is NOT a range error in Go — only magnitudes strictly beyond it
      // are. A range check that's off-by-one in the strict direction would wrongly
      // reject this legitimate (if enormous) configured size and fall back to the
      // 256KiB default instead of the requested cap.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-int64-boundary-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "9223372036854775807";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
        // The 5116-byte statement fits comfortably under the (enormous) configured
        // limit, so this must succeed, not fall back to the 256KiB default.
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "rejects an oversized statement when SUPABASE_SCANNER_BUFFER_SIZE is set only in the project env (Go loadNestedEnv parity)",
    () => {
      // `loadNestedEnv` `os.Setenv`s every
      // project-`.env` key that isn't already in the shell env BEFORE the command body
      // runs, so `viper.AutomaticEnv()` sees a `supabase/.env`-only
      // `SUPABASE_SCANNER_BUFFER_SIZE` exactly like a real shell-exported one.
      // `legacyApplySchemaFiles`'s `projectEnv` parameter threads the caller's already
      // -loaded `legacyLoadProjectEnv` map through to the same check.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-projectenv-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
          { SUPABASE_SCANNER_BUFFER_SIZE: "100b" },
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const msg = JSON.stringify(exit.cause);
          expect(msg).toContain("bufio.Scanner: token too long");
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous !== undefined) process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "shell env still wins over the project env for SUPABASE_SCANNER_BUFFER_SIZE (Go godotenv 'never overrides' parity)",
    () => {
      // `godotenv.Load`'s `overload=false` never sets a key already present in
      // `os.Environ()` — the shell value must
      // win even when a (different) project-env value is also threaded through.
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-shellwins-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT '${"a".repeat(5000)}';\n`);
      const { session, calls } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      // Shell explicitly unsets enforcement (0 → treated as unset, no check) while the
      // project env sets a tiny limit — the shell value must win.
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "0";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacyApplySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
          { SUPABASE_SCANNER_BUFFER_SIZE: "100b" },
        );
        expect(executedSql(calls).some((sql) => sql.startsWith("SELECT 'a"))).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );
});

describe("legacyRevertsToLoginRole", () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["reset role", true],
    ["RESET SESSION AUTHORIZATION", true],
    ["set role none", true],
    ["set role to none", true],
    ["set role = default", true],
    ["set session role none", true],
    ["set session authorization default", true],
    ["discard all", true],
    // `check_role` compares quoted values case-sensitively against "none".
    ["set role 'none'", true],
    ['set role "none"', true],
    ["-- c\nreset role", true],
    ["set role 'NONE'", false],
    ['set role "NONE"', false],
    ["set role none_user", false],
    ["set role nonesuch", false],
    // Session-scoped restore would override the transaction scope.
    ["set local role none", false],
    // `role` carries GUC_NO_RESET_ALL.
    ["reset all", false],
    ["discard temp", false],
    ["set session authorization 'bob'", false],
    ["set roles none", false],
    ["select 'reset role'", false],
  ];

  it.each(cases)("%s -> %s", (sql, want) => {
    expect(legacyRevertsToLoginRole(sql)).toBe(want);
  });
});
