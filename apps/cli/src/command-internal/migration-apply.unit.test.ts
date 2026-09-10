import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { DbConnectError } from "./db-connection.errors.ts";
import type { DbBatchStatement, DbSession } from "./db-connection.service.ts";
import {
  applyMigrationFile,
  applyRenderedSqlUnits,
  applySchemaFiles,
  hasTransactionControl,
  isPipelineIncompatible,
  markError,
  revertsToLoginRole,
  seedGlobals,
} from "./migration-apply.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

class FakeExecError extends Data.TaggedError("DbExecError")<{
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
    batchConnectionLost?: string;
  } = {},
) {
  const calls: Array<{
    kind: "exec" | "batch" | "query";
    sql: string;
    statements?: ReadonlyArray<DbBatchStatement>;
    params?: ReadonlyArray<unknown>;
  }> = [];
  const session: DbSession = {
    ...(opts.restoreRoleSql === undefined ? {} : { restoreRoleSql: opts.restoreRoleSql }),
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
      if (opts.batchConnectionLost !== undefined) {
        return Effect.fail(new DbConnectError({ message: opts.batchConnectionLost }));
      }
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
    readonly statements?: ReadonlyArray<DbBatchStatement>;
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
  session: DbSession,
  migrationPath: string,
  onStatementsCommitted?: Effect.Effect<void>,
): Effect.Effect<void, TestError | DbConnectError> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* applyMigrationFile(
      session,
      fs,
      path,
      migrationPath,
      (message) => new TestError({ message }),
      onStatementsCommitted,
    );
  }).pipe(Effect.provide(BunServices.layer));

describe("applyRenderedSqlUnits", () => {
  it.effect("applies mixed transaction modes in unit order without history or reset writes", () => {
    const { session, calls } = fakeSession();
    return applyRenderedSqlUnits(
      session,
      [
        {
          name: "tables",
          sql: "CREATE TABLE widgets (id bigint);\nALTER TABLE widgets ENABLE ROW LEVEL SECURITY;",
          transactionMode: "transactional",
        },
        {
          name: "enum",
          sql: "SET check_function_bodies = off;\nALTER TYPE mood ADD VALUE 'fine';",
          transactionMode: "none",
        },
        {
          name: "grants",
          sql: "GRANT SELECT ON TABLE widgets TO anon;",
          transactionMode: "transactional",
        },
      ],
      (message) => new TestError({ message }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.map(({ kind }) => kind)).toEqual(["batch", "exec", "exec", "batch"]);
          expect(executedSql(calls)).toEqual([
            "CREATE TABLE widgets (id bigint)",
            "ALTER TABLE widgets ENABLE ROW LEVEL SECURITY",
            "SET check_function_bodies = off",
            "ALTER TYPE mood ADD VALUE 'fine'",
            "GRANT SELECT ON TABLE widgets TO anon",
          ]);
          expect(executedSql(calls).some((sql) => sql === "RESET ALL")).toBe(false);
          expect(
            calls.some(
              ({ sql }) => sql.includes("supabase_migrations") || sql.includes("schema_migrations"),
            ),
          ).toBe(false);
          expect(calls.some(({ kind }) => kind === "query")).toBe(false);
        }),
      ),
    );
  });

  it.effect("maps transactional failures with the unit-local statement index", () => {
    const { session, calls } = fakeSession({ failOn: "missing_column" });
    return applyRenderedSqlUnits(
      session,
      [
        {
          name: "broken",
          sql: "SELECT 1;\nSELECT missing_column;\nSELECT 3;",
          transactionMode: "transactional",
        },
        {
          name: "not_reached",
          sql: "SELECT 4;",
          transactionMode: "transactional",
        },
      ],
      (message) => new TestError({ message }),
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("SELECT missing_column");
          expect(executedSql(calls)).not.toContain("SELECT 4");
        }),
      ),
    );
  });

  it.effect(
    "restores a stepped-down role after a sequential failure without resetting the unit",
    () => {
      const restoreRoleSql = "SET SESSION ROLE postgres";
      const { session, calls } = fakeSession({
        failOn: "missing_column",
        restoreRoleSql,
      });
      return applyRenderedSqlUnits(
        session,
        [
          {
            name: "broken_nontransactional",
            sql: "RESET ROLE;\nSELECT missing_column;",
            transactionMode: "none",
          },
        ],
        (message) => new TestError({ message }),
      ).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error.message).toContain("At statement: 1");
            expect(executedSql(calls)).toEqual([
              "RESET ROLE",
              restoreRoleSql,
              "SELECT missing_column",
              restoreRoleSql,
            ]);
            expect(executedSql(calls)).not.toContain("RESET ALL");
            expect(calls.some(({ kind }) => kind === "query")).toBe(false);
          }),
        ),
      );
    },
  );
});

describe("applyMigrationFile", () => {
  it.effect(
    "creates the history table, then runs the statements + history insert in a transaction",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "apply-"));
      const file = join(dir, "20240101120000_add_col.sql");
      writeFileSync(file, "ALTER TABLE a ADD COLUMN b int;\nCREATE INDEX i ON a(b);");
      const { session, calls } = fakeSession();
      return run(session, file).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const execs = executedSql(calls);
            expect(execs).toContain("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
            expect(execs).toContain("RESET ALL");
            expect(execs[0]).toBe("RESET ALL");
            const firstBegin = execs.indexOf("BEGIN");
            const setupCommit = execs.indexOf("COMMIT");
            const setLocal = execs.indexOf("SET LOCAL lock_timeout = '4s'");
            expect(firstBegin).toBe(1);
            expect(setLocal).toBeGreaterThan(firstBegin);
            expect(setLocal).toBeLessThan(setupCommit);
            const migrationBatch = calls.find((call) => call.kind === "batch");
            expect(migrationBatch?.statements?.map(({ sql }) => sql)).toEqual([
              "ALTER TABLE a ADD COLUMN b int",
              "CREATE INDEX i ON a(b)",
              expect.stringContaining("supabase_migrations.schema_migrations"),
            ]);
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

  it.effect("records a versioned empty migration in one batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_boom.sql");
    writeFileSync(file, "ALTER TABLE a ADD COLUMN b int;");
    const { session, calls } = fakeSession({ failOn: "ADD COLUMN b int" });
    return run(session, file).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.filter((call) => call.kind === "batch")).toHaveLength(1);
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

  it.effect("surfaces a lost batch connection verbatim, never as a failing statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_lost.sql");
    writeFileSync(file, "ALTER TABLE a ADD COLUMN b int;");
    const { session } = fakeSession({
      batchConnectionLost: "connection to the database was lost before the batch could be sent",
    });
    return run(session, file).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(DbConnectError);
          expect(error.message).toBe(
            "connection to the database was lost before the batch could be sent",
          );
          const rendered = JSON.stringify(error);
          expect(rendered).not.toContain("At statement:");
          expect(rendered).not.toContain("ALTER TABLE a ADD COLUMN b int");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("sends a large compatible migration in one batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
      const dir = mkdtempSync(join(tmpdir(), "apply-read-fail-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches).toHaveLength(2);
          expect(batches[0]?.statements?.map(({ sql }) => sql)).toEqual([
            "create table a (id int)",
          ]);
          expect(batches[1]?.statements?.map(({ sql }) => sql)).toEqual([
            "ALTER TABLE a ENABLE ROW LEVEL SECURITY",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          const insert = batches[1]?.statements?.at(-1);
          expect(insert?.params?.[0]).toBe("20240101120000");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors pg-delta's file-level no-transaction directive", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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

          expect(execs.filter((sql) => sql === "BEGIN")).toHaveLength(1);
          expect(execs.filter((sql) => sql === "COMMIT")).toHaveLength(1);
          expect(set).toBeGreaterThan(setupCommit);
          expect(action).toBeGreaterThan(set);
          expect(cleanup).toBeGreaterThan(action);

          const history = calls.filter(
            (call) => call.kind === "query" && call.params !== undefined,
          );
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
          expect(calls.some((call) => call.kind === "query" && call.params !== undefined)).toBe(
            false,
          );
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("At statement: 1");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not notify after a no-transaction SET preamble when later SQL fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_drop_subscription.sql");
    writeFileSync(
      file,
      "-- pg-delta: transaction=false\n" +
        "SET check_function_bodies = off;\n" +
        "DROP SUBSCRIPTION app_events;\n" +
        "RESET ALL;",
    );
    const { session } = fakeSession({ failOn: "DROP SUBSCRIPTION" });
    let committed = 0;
    return run(
      session,
      file,
      Effect.sync(() => {
        committed += 1;
      }),
    ).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(committed).toBe(0);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("notifies after a no-transaction statement commits before a later failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_drop_subscription.sql");
    writeFileSync(
      file,
      "-- pg-delta: transaction=false\n" +
        "CREATE TABLE widgets (id bigint);\n" +
        "DROP SUBSCRIPTION app_events;\n" +
        "RESET ALL;",
    );
    const { session } = fakeSession({ failOn: "DROP SUBSCRIPTION" });
    let committed = 0;
    return run(
      session,
      file,
      Effect.sync(() => {
        committed += 1;
      }),
    ).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(committed).toBe(1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("notifies after flushing a batch before a pipeline-incompatible failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_add_index.sql");
    writeFileSync(file, "create table a (id int);\nCREATE INDEX CONCURRENTLY a_idx ON a(id);");
    const { session } = fakeSession({ failOn: "CONCURRENTLY" });
    let committed = 0;
    return run(
      session,
      file,
      Effect.sync(() => {
        committed += 1;
      }),
    ).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(committed).toBe(1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports a pipeline-incompatible statement failure with its statement index", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
            expect(msg).toContain("At statement: 1");
            expect(msg).toContain("CREATE INDEX CONCURRENTLY a_idx ON a(id)");
          }
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_authored.sql");
    writeFileSync(file, "BEGIN;\nSET LOCAL check_function_bodies = off;\nCOMMIT;");
    const { session, calls } = fakeSession();
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = calls.filter((call) => call.kind === "exec").map((call) => call.sql);
          expect(execs.filter((sql) => sql === "BEGIN")).toHaveLength(2);
          expect(execs.filter((sql) => sql === "COMMIT")).toHaveLength(2);
          expect(execs).toContain("SET LOCAL check_function_bodies = off");
          const history = calls.filter(
            (call) => call.kind === "query" && call.params !== undefined,
          );
          expect(history).toHaveLength(1);
          expect(history[0]?.params?.[0]).toBe("20240101120000");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps savepoint rollback inside the managed migration transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
          const batches = calls.filter((call) => call.kind === "batch");
          expect(batches).toHaveLength(1);
          expect(batches[0]?.statements?.map(({ sql }) => sql)).toEqual([
            "SAVEPOINT before_change",
            "UPDATE accounts SET active = false",
            "ROLLBACK TO SAVEPOINT before_change",
            "SELECT 1",
            expect.stringContaining("supabase_migrations.schema_migrations"),
          ]);
          expect(
            calls.filter((call) => call.kind === "query" && call.params !== undefined),
          ).toHaveLength(0);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not record history when an authored transaction fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_authored.sql");
    writeFileSync(file, "BEGIN;\nCREATE TABLE broken (;\nCOMMIT;");
    const { session, calls } = fakeSession({ failOn: "CREATE TABLE broken" });
    return run(session, file).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.some((call) => call.kind === "query" && call.params !== undefined)).toBe(
            false,
          );
          expect(calls.some((call) => call.kind === "exec" && call.sql === "ROLLBACK")).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "re-asserts the stepped-down role between the statements and the history insert",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "apply-"));
      const file = join(dir, "20240101120000_reset_role.sql");
      writeFileSync(file, "set role repro_writer;\ncreate table t (id int);\nreset role;");
      const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
      return run(session, file).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const batch = calls.find((call) => call.kind === "batch");
            expect(batch?.statements?.map(({ sql }) => sql)).toEqual([
              "set role repro_writer",
              "create table t (id int)",
              "reset role",
              "SET SESSION ROLE postgres",
              expect.stringContaining("supabase_migrations.schema_migrations"),
            ]);
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
          const history = calls.findIndex(
            (call) => call.kind === "query" && call.params !== undefined,
          );
          expect(lastRestore).toBeGreaterThan(authoredCommit);
          expect(history).toBeGreaterThan(lastRestore);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the history insert's statement index when the role restore precedes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("INSERT INTO supabase_migrations.schema_migrations");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps a mid-batch failure's statement index when a restore op is appended", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
    const file = join(dir, "20240101120000_seq_reset.sql");
    writeFileSync(file, "-- pg-delta: transaction=false\nset role r;\nreset role;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return run(session, file).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = calls.filter((call) => call.kind === "exec").map((call) => call.sql);
          expect(execs.filter((sql) => sql === "SET SESSION ROLE postgres")).toHaveLength(1);
          expect(execs[execs.indexOf("reset role") + 1]).toBe("SET SESSION ROLE postgres");
          expect(
            calls.filter((call) => call.kind === "query" && call.params !== undefined),
          ).toHaveLength(1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps the deferred-failure index when mid-file restores were injected", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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
          expect(error.message).toContain("At statement: 1");
          expect(error.message).toContain("SET SESSION ROLE postgres");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps statement numbering across an injected mid-file restore", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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

describe("hasTransactionControl", () => {
  it("recognizes authored boundaries after comments without matching routine bodies", () => {
    expect(hasTransactionControl("-- authored\nBEGIN")).toBe(true);
    expect(hasTransactionControl("START TRANSACTION ISOLATION LEVEL SERIALIZABLE")).toBe(true);
    expect(
      hasTransactionControl("CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql"),
    ).toBe(false);
  });

  it("distinguishes transaction rollback from savepoint rollback", () => {
    for (const sql of ["ROLLBACK", "ROLLBACK WORK", "ROLLBACK TRANSACTION"]) {
      expect(hasTransactionControl(sql)).toBe(true);
    }
    for (const sql of [
      "ROLLBACK TO before_change",
      "ROLLBACK TO SAVEPOINT before_change",
      "ROLLBACK WORK TO SAVEPOINT before_change",
      "ROLLBACK TRANSACTION TO before_change",
    ]) {
      expect(hasTransactionControl(sql)).toBe(false);
    }
  });
});

describe("migration failure rendering (Go ExecBatch parity)", () => {
  // Error message layout: `<pg error>\n[Detail]\n[42704 hint]\n` then
  // `At statement: <i>\n<caret-marked statement>`.
  const failing = (
    sql: string,
    failWith: { message: string; code?: string; detail?: string; position?: number },
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "apply-"));
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

describe("markError", () => {
  it("places the caret under a mid-statement position", () => {
    expect(markError("create table t (col ltree)", 21)).toBe(
      "create table t (col ltree)\n                    ^",
    );
  });

  it("returns the statement unchanged for position 0 (absent)", () => {
    expect(markError("create table t (col ltree)", 0)).toBe("create table t (col ltree)");
  });

  it("returns the statement unchanged when the position is past the end", () => {
    expect(markError("abc", 99)).toBe("abc");
  });

  it("returns the statement unchanged when the position lands on a line break", () => {
    expect(markError("ab\ncd", 3)).toBe("ab\ncd");
  });

  it("marks a position on a later line and drops the lines after it", () => {
    expect(markError("create table t (\n  col ltree\n)", 20)).toBe(
      "create table t (\n  col ltree\n  ^",
    );
    expect(markError("l1\nl2\nl3\nl4", 4)).toBe("l1\nl2\n^");
  });

  it("places the caret under the last character when the position equals the line length", () => {
    expect(markError("abcde", 5)).toBe("abcde\n    ^");
  });

  it("consumes the position in UTF-8 bytes like Go, not characters", () => {
    expect(markError("héllo\nworld", 8)).toBe("héllo\nworld\n^");
    expect(markError("sélect 1", 3)).toBe("sélect 1\n  ^");
  });
});

describe("isPipelineIncompatible", () => {
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
    expect(isPipelineIncompatible(sql)).toBe(want);
  });
});

describe("seedGlobals", () => {
  it.effect("runs the globals file WITHOUT RESET ALL and without a history insert", () => {
    const dir = mkdtempSync(join(tmpdir(), "globals-"));
    const file = join(dir, "roles.sql");
    writeFileSync(file, "CREATE ROLE my_role;");
    const { session, calls } = fakeSession();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedGlobals(session, fs, path, [file], (message) => new TestError({ message }));
      const execs = executedSql(calls);
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
    // Globals run on the same session as the later vault upsert and history-table DDL, so a role
    // must not leak into them.
    const dir = mkdtempSync(join(tmpdir(), "globals-"));
    const file = join(dir, "roles.sql");
    writeFileSync(file, "CREATE ROLE my_role;\nset role my_role;\nreset role;");
    const { session, calls } = fakeSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedGlobals(session, fs, path, [file], (message) => new TestError({ message }));
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

describe("applySchemaFiles", () => {
  it.effect(
    "reports a read failure with the workdir-relative path, not the absolute path used to read it (Go open supabase/... parity)",
    () => {
      // An unreadable file (permission denied, not missing) still passes the glob's own
      // stat/type check, since that only needs directory execute permission, not read access to
      // the file itself.
      const dir = mkdtempSync(join(tmpdir(), "schema-files-read-fail-"));
      const file = join(dir, "supabase", "unreadable.sql");
      mkdirSync(join(dir, "supabase"), { recursive: true });
      writeFileSync(file, "select 1;");
      chmodSync(file, 0o000);
      const { session } = fakeSession();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      // Exceeds the 4096-byte floor the scanner always starts at, regardless of the configured
      // limit.
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "100b";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-empty-token-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `;\nSELECT '${"a".repeat(5000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "100b";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-default-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT '${"a".repeat(5000)}';\n`);
      const { session, calls } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-garbage-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(300_000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "5M";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-hex-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "0x1400";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-underscore-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "5_120";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-bad-underscore-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "_5120";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-int64-overflow-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(300_000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "9223372036854775808";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-int64-boundary-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5116)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "9223372036854775807";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
          session,
          fs,
          path,
          dir,
          ["supabase/big.sql"],
          (message, suggestion) =>
            new TestError({ message: suggestion ? `${message} (${suggestion})` : message }),
        ).pipe(Effect.exit);
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-projectenv-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT 1;\nSELECT '${"a".repeat(5000)}';\n`);
      const { session } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* applySchemaFiles(
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
      const dir = mkdtempSync(join(tmpdir(), "schema-files-scanner-shellwins-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      writeFileSync(file, `SELECT '${"a".repeat(5000)}';\n`);
      const { session, calls } = fakeSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      // "0" is treated as unset (no check); the shell value must still win over the project
      // env's tiny limit.
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "0";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* applySchemaFiles(
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

describe("revertsToLoginRole", () => {
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
    expect(revertsToLoginRole(sql)).toBe(want);
  });
});
