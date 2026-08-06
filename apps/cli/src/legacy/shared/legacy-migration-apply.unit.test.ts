import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  legacyApplyMigrationFile,
  legacyApplySchemaFiles,
  legacyIsPipelineIncompatible,
  legacyMarkError,
  legacySeedGlobals,
} from "./legacy-migration-apply.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

class FakeExecError extends Data.TaggedError("LegacyDbExecError")<{
  readonly message: string;
  readonly code?: string;
  readonly detail?: string;
  readonly position?: number;
}> {}

function fakeSession(
  opts: {
    failOn?: string;
    failWith?: { message: string; code?: string; detail?: string; position?: number };
  } = {},
) {
  const calls: Array<{ kind: "exec" | "query"; sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: LegacyDbSession = {
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return opts.failOn !== undefined && sql.includes(opts.failOn)
        ? Effect.fail(new FakeExecError(opts.failWith ?? { message: "exec failed" }))
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

  it.effect(
    "wraps a read failure with Go's parse-file error text (Go NewMigrationFromFile parity)",
    () => {
      // Go's `NewMigrationFromFile`/`parseFile` wraps the open failure as
      // `"failed to open migration file: %w"` (`pkg/migration/file.go:57-58`) before
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

describe("migration failure rendering (Go ExecBatch parity)", () => {
  // Byte-exact ports of Go's `(*MigrationFile).ExecBatch` error layout
  // (`pkg/migration/file.go:88-113`): `<pg error>\n[Detail]\n[42704 hint]\n`
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
  // Every expectation below is pinned against Go's `markError` output
  // (`pkg/migration/file.go:117-132`), captured by running the Go function
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
    ["bom before vacuum", "\uFEFFVACUUM", true],
    // Negatives — compatible statements that must keep running inside the batch transaction.
    ["plain create index", "CREATE INDEX widgets_id_idx ON public.widgets(id)", false],
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
      // Go's `parser.Split` (`pkg/parser/token.go:81-119`) only enforces
      // `SUPABASE_SCANNER_BUFFER_SIZE` when it's explicitly set — `parseFile`
      // otherwise auto-grows the scanner to the real file's byte length, so the
      // DEFAULT path can never hit `bufio.ErrTooLong`. With it set below a single
      // statement's raw byte length, Go fails with `bufio.Scanner: token too long`
      // instead of silently applying the oversized statement — verified empirically
      // against `apps/cli-go/pkg/parser` (a `parser.SplitAndTrim` scratch probe).
      const dir = mkdtempSync(join(tmpdir(), "legacy-schema-files-scanner-"));
      mkdirSync(join(dir, "supabase"), { recursive: true });
      const file = join(dir, "supabase", "big.sql");
      // A single, un-splittable statement whose raw text exceeds the 4096-byte floor
      // (Go's `bufio.Scanner` starts at that size regardless of the configured limit).
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
        expect(calls.some((c) => c.kind === "exec" && c.sql.startsWith("SELECT 'a"))).toBe(true);
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
      // Verified empirically against `apps/cli-go/pkg/parser` + vendored
      // `viper@v1.21.0`: a bare multiplier suffix with NO trailing "b"/"B" (e.g. "5M")
      // is NOT 5 MiB in real Go — `parseSizeInBytes` only recognizes a multiplier when
      // the string's LAST character is literally "b"/"B", so "5M" never strips a
      // suffix and `cast.ToInt("5M")` fails whole, yielding 0. `viper.IsSet` is still
      // true (the var IS present), so `parseFile`'s file-size auto-growth never runs
      // — `parser.Split` falls back to its OWN hardcoded default cap
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
          // 256KiB (Go's `parser.MaxScannerCapacity` default), not "5MB" and not ~0KB.
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
    "rejects an oversized statement when SUPABASE_SCANNER_BUFFER_SIZE is set only in the project env (Go loadNestedEnv parity)",
    () => {
      // Go's `loadNestedEnv` (`pkg/config/config.go:1220`) `os.Setenv`s every
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
      // `os.Environ()` (`godotenv@v1.5.1/godotenv.go:184-200`) — the shell value must
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
        expect(calls.some((c) => c.kind === "exec" && c.sql.startsWith("SELECT 'a"))).toBe(true);
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
