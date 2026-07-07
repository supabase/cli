import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  legacyApplyMigrationFile,
  legacyIsPipelineIncompatible,
  legacySeedGlobals,
} from "./legacy-migration-apply.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

class FakeExecError extends Data.TaggedError("LegacyDbExecError")<{ readonly message: string }> {}

function fakeSession(opts: { failOn?: string } = {}) {
  const calls: Array<{ kind: "exec" | "query"; sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: LegacyDbSession = {
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return opts.failOn !== undefined && sql.includes(opts.failOn)
        ? Effect.fail(new FakeExecError({ message: "exec failed" }))
        : Effect.void;
    },
    query: (sql, params) => {
      calls.push({ kind: "query", sql, params });
      return Effect.succeed([]);
    },
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

const run = (session: LegacyDbSession, migrationPath: string): Effect.Effect<void, TestError> =>
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
            const execs = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
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
            // The migration's own statements run in a later, separate transaction.
            const lastBegin = execs.lastIndexOf("BEGIN");
            const lastCommit = execs.lastIndexOf("COMMIT");
            expect(lastBegin).toBeGreaterThan(setupCommit);
            expect(execs.indexOf("ALTER TABLE a ADD COLUMN b int")).toBeGreaterThan(lastBegin);
            expect(execs.indexOf("CREATE INDEX i ON a(b)")).toBeLessThan(lastCommit);
            // History insert carries version, name, and the statements array.
            const insert = calls.find((c) => c.kind === "query");
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
          expect(calls.some((c) => c.kind === "exec" && c.sql === "ROLLBACK")).toBe(true);
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
          const execs = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          const concurrently = "CREATE INDEX CONCURRENTLY a_idx ON a(id)";
          expect(execs).toContain(concurrently);
          // The CONCURRENTLY statement must not run inside an open transaction, or
          // PostgreSQL rejects it (SQLSTATE 25001). The batch is flushed first, so the
          // BEGIN/COMMIT counts before it must balance (no open transaction).
          const before = execs.slice(0, execs.indexOf(concurrently));
          expect(before.filter((s) => s === "BEGIN").length).toBe(
            before.filter((s) => s === "COMMIT").length,
          );
          // The compatible statements still ran inside a transaction...
          expect(before).toContain("BEGIN");
          expect(before).toContain("COMMIT");
          // ...and the trailing compatible statement reopens a transaction after it.
          const after = execs.slice(execs.indexOf(concurrently) + 1);
          expect(after).toContain("BEGIN");
          expect(after.indexOf("ALTER TABLE a ENABLE ROW LEVEL SECURITY")).toBeGreaterThanOrEqual(
            0,
          );
          // The migration is still recorded once every statement succeeds.
          const insert = calls.find((c) => c.kind === "query");
          expect(insert?.params?.[0]).toBe("20240101120000");
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
          expect(calls.some((c) => c.kind === "query")).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("legacyIsPipelineIncompatible", () => {
  // Mirrors Go's `TestIsPipelineIncompatible` (`pkg/migration/file_test.go`, supabase/cli#5156).
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
    // Negatives — compatible statements that must keep running inside the batch transaction.
    ["plain create index", "CREATE INDEX widgets_id_idx ON public.widgets(id)", false],
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
      const execs = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
      // Go's SeedGlobals calls ExecBatch directly — no RESET ALL (that's only the
      // migration-apply path) and no schema-migrations history insert.
      expect(execs).not.toContain("RESET ALL");
      expect(execs).toContain("CREATE ROLE my_role");
      expect(calls.some((c) => c.kind === "query")).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(BunServices.layer),
    );
  });
});
