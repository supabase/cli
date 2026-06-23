import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyApplyMigrationFile } from "./legacy-migration-apply.ts";

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
            // Statements run between BEGIN and COMMIT.
            const begin = execs.indexOf("BEGIN");
            const commit = execs.indexOf("COMMIT");
            expect(begin).toBeGreaterThanOrEqual(0);
            expect(commit).toBeGreaterThan(begin);
            expect(execs.indexOf("ALTER TABLE a ADD COLUMN b int")).toBeGreaterThan(begin);
            expect(execs.indexOf("CREATE INDEX i ON a(b)")).toBeLessThan(commit);
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
});
