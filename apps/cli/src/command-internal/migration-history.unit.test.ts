import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { stripAnsi } from "../../tests/helpers/ansi.ts";
import { DbExecError } from "./db-connection.errors.ts";
import type { DbSession } from "./db-connection.service.ts";
import {
  createMigrationTable,
  createSeedTable,
  findPendingMigrations,
  listRemoteMigrations,
  reconcileMigrations,
  resolveMigrationFile,
  suggestMigrationRepair,
  suggestRevertHistory,
} from "./migration-history.ts";

const mig = (version: string) => `supabase/migrations/${version}_test.sql`;

/** Minimal session whose `query` fails with the given error. */
const failingSession = (error: DbExecError): DbSession => ({
  exec: () => Effect.die("unused"),
  execBatch: () => Effect.die("unused"),
  query: () => Effect.fail(error),
  extensionExists: () => Effect.die("unused"),
  copyToCsv: () => Effect.die("unused"),
  queryRaw: () => Effect.die("unused"),
});

describe("reconcileMigrations", () => {
  it("reports in-sync when remote and local match", () => {
    expect(reconcileMigrations(["20240101000000"], ["20240101000000"], "--remote")).toEqual({
      kind: "in-sync",
    });
  });

  it("reports missing only when both histories are empty", () => {
    expect(reconcileMigrations([], [], "--remote")).toEqual({ kind: "missing" });
    expect(reconcileMigrations(["20240101000000"], [], "--remote").kind).toBe("conflict");
  });

  it("reports a conflict with an extra remote migration", () => {
    const result = reconcileMigrations(["20240101000000"], ["20240102000000"], "--remote");
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(stripAnsi(result.suggestion)).toContain(
        "supabase migration repair --status reverted 20240101000000 --remote",
      );
      expect(stripAnsi(result.suggestion)).toContain(
        "supabase migration repair --status applied 20240102000000 --remote",
      );
    }
  });

  it("reports a conflict with an extra local migration", () => {
    const result = reconcileMigrations([], ["20240102000000"], "--remote");
    expect(result.kind).toBe("conflict");
  });

  it("is in sync when an 8-digit and a 14-digit version share a prefix (#6036)", () => {
    expect(
      reconcileMigrations(
        ["20260420", "20260420010000"],
        ["20260420010000", "20260420"],
        "--remote",
      ),
    ).toEqual({ kind: "in-sync" });
  });

  it("skips versions that do not parse as integers", () => {
    expect(
      reconcileMigrations(["bogus", "20240101000000"], ["20240101000000"], "--remote"),
    ).toEqual({
      kind: "in-sync",
    });
  });

  it("skips empty / whitespace versions (not Number() coercion)", () => {
    expect(
      reconcileMigrations(["", "20240101000000"], [" ", "20240101000000"], "--remote"),
    ).toEqual({
      kind: "in-sync",
    });
  });

  it("treats a version within the int64 range as a real conflict", () => {
    expect(reconcileMigrations(["9999999999999999"], [], "--remote").kind).toBe("conflict");
  });

  it("skips a version beyond the int64 range instead of hanging the scan", () => {
    expect(
      reconcileMigrations(
        ["20240101000000", "9999999999999999999"],
        ["20240101000000"],
        "--remote",
      ),
    ).toEqual({ kind: "in-sync" });
  });
});

describe("listRemoteMigrations (suppress only undefined_table)", () => {
  const run = (error: DbExecError) => listRemoteMigrations(failingSession(error)).pipe(Effect.exit);

  it.effect("treats a missing history table (42P01) as an empty history", () =>
    Effect.gen(function* () {
      const exit = yield* run(
        new DbExecError({
          message: 'relation "supabase_migrations.schema_migrations" does not exist',
          code: "42P01",
        }),
      );
      expect(exit).toStrictEqual(Exit.succeed([]));
    }),
  );

  it.effect("propagates a malformed table (undefined column 42703) instead of swallowing it", () =>
    Effect.gen(function* () {
      const exit = yield* run(
        new DbExecError({ message: 'column "version" does not exist', code: "42703" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("falls back to a relation-not-exist message when no SQLSTATE is surfaced", () =>
    Effect.gen(function* () {
      const exit = yield* run(
        new DbExecError({
          message: 'relation "supabase_migrations.schema_migrations" does not exist',
        }),
      );
      expect(exit).toStrictEqual(Exit.succeed([]));
    }),
  );

  it.effect("does not swallow a column-not-exist message when no SQLSTATE is surfaced", () =>
    Effect.gen(function* () {
      const exit = yield* run(new DbExecError({ message: 'column "version" does not exist' }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("findPendingMigrations", () => {
  it("returns the local paths after the remote count when in sync", () => {
    const local = ["0", "1", "2"].map(mig);
    const result = findPendingMigrations(local, ["0"]);
    expect(result).toEqual({ kind: "pending", paths: [mig("1"), mig("2")] });
  });

  it("is up to date when an 8-digit and a 14-digit version share a prefix (#6036)", () => {
    const local = ["20260420010000", "20260420"].map(mig);
    const result = findPendingMigrations(local, ["20260420", "20260420010000"]);
    expect(result).toEqual({ kind: "pending", paths: [] });
  });

  it("flags out-of-order local migrations as missing-remote", () => {
    // local [0,1,2,3], remote [0,2] → unapplied [1] (1 sits before applied 2).
    const local = ["20221201000000", "20221201000001", "20221201000002", "20221201000003"].map(mig);
    const result = findPendingMigrations(local, ["20221201000000", "20221201000002"]);
    expect(result).toEqual({ kind: "missing-remote", paths: [mig("20221201000001")] });
  });

  it("flags a remote version absent from local as missing-local", () => {
    // local [0,2], remote [0,1,2,3,4] → missing [1,3,4].
    const local = ["20221201000000", "20221201000002"].map(mig);
    const result = findPendingMigrations(local, [
      "20221201000000",
      "20221201000001",
      "20221201000002",
      "20221201000003",
      "20221201000004",
    ]);
    expect(result).toEqual({
      kind: "missing-local",
      versions: ["20221201000001", "20221201000003", "20221201000004"],
    });
  });

  it("prefers missing-local when both missing-local and missing-remote occur", () => {
    // local [0,1,2,3], remote [2,4] → unapplied [0,1,3] but remote 4 missing → missing-local [4].
    const local = ["20221201000000", "20221201000001", "20221201000002", "20221201000003"].map(mig);
    const result = findPendingMigrations(local, ["20221201000002", "20221201000004"]);
    expect(result).toEqual({ kind: "missing-local", versions: ["20221201000004"] });
  });
});

describe("suggestMigrationRepair", () => {
  it("lists reverted (remote) then applied (local) repair commands for the target", () => {
    const out = stripAnsi(suggestMigrationRepair(["111"], ["222"], "--remote"));
    expect(out).toContain("try repairing the migration history table:");
    expect(out).toContain("supabase migration repair --status reverted 111 --remote");
    expect(out).toContain("supabase migration repair --status applied 222 --remote");
  });

  it("puts the target last in every repair command, so --remote cannot swallow a version", () => {
    expect(stripAnsi(suggestMigrationRepair(["111"], [], "--local"))).toContain(
      "supabase migration repair --status reverted 111 --local",
    );
    expect(stripAnsi(suggestMigrationRepair([], ["222"], "--remote=<db-url>"))).toContain(
      "supabase migration repair --status applied 222 --remote=<db-url>",
    );
  });
});

describe("suggestRevertHistory", () => {
  it("builds the revert-history suggestion with a trailing newline per line", () => {
    const out = stripAnsi(suggestRevertHistory(["0002", "0003"], "--remote"));
    expect(out).toContain("supabase migration repair --status reverted 0002 0003 --remote");
    expect(out).toContain("supabase db pull --remote");
    expect(out).toMatch(/\n$/u);
  });
});

describe("resolveMigrationFile (byte-ordered match)", () => {
  it.effect("picks the UTF-8-byte-first match, not JS's default UTF-16 code-unit order", () => {
    // A supplementary-plane character (U+1F600, a UTF-16 surrogate pair) alongside a BMP
    // private-use character (U+E000): JS's default `.sort()` ranks the surrogate pair first —
    // its leading high-surrogate code unit (0xD83D) is less than the private-use code unit
    // (0xE000) — while byte-wise UTF-8 order ranks the private-use character first instead
    // (0xEE... < 0xF0...).
    const surrogatePair = "20240101000000_a\u{1f600}.sql";
    const privateUse = "20240101000000_a\u{e000}.sql";
    expect([surrogatePair, privateUse].sort()[0]).toBe(surrogatePair);

    const layer = Layer.mergeAll(
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () => Effect.succeed([surrogatePair, privateUse]),
        }),
      ),
      Path.layer,
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* resolveMigrationFile(
        fs,
        path,
        "/supabase/migrations",
        "20240101000000",
      );
      expect(Option.isSome(result) ? result.value : undefined).toBe(
        `/supabase/migrations/${privateUse}`,
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("createMigrationTable / createSeedTable (provisioning probe, #6393)", () => {
  const HISTORY_DDL = [
    "BEGIN",
    "SET LOCAL lock_timeout = '4s'",
    "CREATE SCHEMA IF NOT EXISTS supabase_migrations",
    "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)",
    "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]",
    "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text",
    "COMMIT",
  ];

  const probedSession = (probeRows: ReadonlyArray<Record<string, unknown>>) => {
    const execs: Array<string> = [];
    const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
    const session: DbSession = {
      exec: (sql) => {
        execs.push(sql);
        return Effect.void;
      },
      execBatch: () => Effect.die("unused"),
      query: (sql, params) => {
        queries.push({ sql, ...(params === undefined ? {} : { params }) });
        return Effect.succeed(probeRows);
      },
      extensionExists: () => Effect.die("unused"),
      copyToCsv: () => Effect.die("unused"),
      queryRaw: () => Effect.die("unused"),
    };
    return { session, execs, queries };
  };

  it.effect("puts no DDL on the wire when a ledger is already provisioned", () =>
    Effect.gen(function* () {
      const { session, execs, queries } = probedSession([{ provisioned: true }]);
      yield* createMigrationTable(session);
      yield* createSeedTable(session);
      expect(execs).toEqual([]);
      expect(queries).toHaveLength(2);
      expect(queries[0]?.sql).toContain("'supabase_migrations.schema_migrations'");
      expect(queries[1]?.sql).toContain("'supabase_migrations.seed_files'");
    }),
  );

  it.effect("keeps the probes on the simple query protocol: no bind parameters", () =>
    Effect.gen(function* () {
      const { session, queries } = probedSession([{ provisioned: true }]);
      yield* createMigrationTable(session);
      yield* createSeedTable(session);
      expect(queries).toHaveLength(2);
      expect(queries.filter((q) => q.params !== undefined)).toEqual([]);
      expect(queries.filter((q) => q.sql.includes("$"))).toEqual([]);
    }),
  );

  for (const [shape, rows] of [
    ["an absent ledger (no rows)", []],
    ["a partial ledger (provisioned: false)", [{ provisioned: false }]],
    ["an unexpected result shape", [{ wat: 1 }]],
  ] as const) {
    it.effect(`runs the full provisioning DDL in order against ${shape}`, () =>
      Effect.gen(function* () {
        const { session, execs } = probedSession([...rows]);
        yield* createMigrationTable(session);
        expect(execs).toEqual(HISTORY_DDL);
      }),
    );
  }

  it.effect("propagates a probe failure without opening a transaction to roll back", () =>
    Effect.gen(function* () {
      const error = new DbExecError({ message: "effect/sql/SqlError: Connection error" });
      const execs: Array<string> = [];
      const session: DbSession = {
        ...failingSession(error),
        exec: (sql) => {
          execs.push(sql);
          return Effect.void;
        },
      };
      expect(yield* Effect.flip(createMigrationTable(session))).toBe(error);
      expect(yield* Effect.flip(createSeedTable(session))).toBe(error);
      expect(execs).toEqual([]);
    }),
  );
});
