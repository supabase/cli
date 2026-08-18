import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  legacyFindPendingMigrations,
  legacyListRemoteMigrations,
  legacyReconcileMigrations,
  legacyResolveMigrationFile,
  legacySuggestMigrationRepair,
  legacySuggestRevertHistory,
} from "./legacy-migration-history.ts";

const mig = (version: string) => `supabase/migrations/${version}_test.sql`;

/** Minimal session whose `query` fails with the given error. */
const failingSession = (error: LegacyDbExecError): LegacyDbSession => ({
  exec: () => Effect.die("unused"),
  execBatch: () => Effect.die("unused"),
  query: () => Effect.fail(error),
  extensionExists: () => Effect.die("unused"),
  copyToCsv: () => Effect.die("unused"),
  queryRaw: () => Effect.die("unused"),
});

describe("legacyReconcileMigrations", () => {
  it("reports in-sync when remote and local match", () => {
    expect(legacyReconcileMigrations(["20240101000000"], ["20240101000000"])).toEqual({
      kind: "in-sync",
    });
  });

  it("reports missing only when both histories are empty", () => {
    // Go checks for conflicts (extra remote/local) before the empty-local guard,
    // so a remote-only migration is a conflict, not missing.
    expect(legacyReconcileMigrations([], [])).toEqual({ kind: "missing" });
    expect(legacyReconcileMigrations(["20240101000000"], []).kind).toBe("conflict");
  });

  it("reports a conflict with an extra remote migration", () => {
    const result = legacyReconcileMigrations(["20240101000000"], ["20240102000000"]);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(stripAnsi(result.suggestion)).toContain(
        "supabase migration repair --status reverted 20240101000000",
      );
      expect(stripAnsi(result.suggestion)).toContain(
        "supabase migration repair --status applied 20240102000000",
      );
    }
  });

  it("reports a conflict with an extra local migration", () => {
    const result = legacyReconcileMigrations([], ["20240102000000"]);
    expect(result.kind).toBe("conflict");
  });

  it("is in sync when an 8-digit and a 14-digit version share a prefix (#6036)", () => {
    // Local versions arrive in file-name order, where `20260420010000_b.sql`
    // precedes `20260420_a.sql` ('0' < '_') — the reverse of the `ORDER BY
    // version` order `schema_migrations` is read back in. Unsorted, the walk
    // desynchronises into a conflict whose repair suggestion asks for the same
    // version to be marked both reverted and applied.
    expect(
      legacyReconcileMigrations(["20260420", "20260420010000"], ["20260420010000", "20260420"]),
    ).toEqual({ kind: "in-sync" });
  });

  it("skips versions that do not parse as integers", () => {
    // A non-numeric remote version is skipped (Go's Atoi-error continue), leaving
    // the numeric ones in sync.
    expect(legacyReconcileMigrations(["bogus", "20240101000000"], ["20240101000000"])).toEqual({
      kind: "in-sync",
    });
  });

  it("skips empty / whitespace versions (matches strconv.Atoi, not Number())", () => {
    // `Number("")`/`Number(" ")` are 0; Go's Atoi errors on both → skip. The
    // numeric entries still reconcile in-sync rather than spuriously conflicting.
    expect(legacyReconcileMigrations(["", "20240101000000"], [" ", "20240101000000"])).toEqual({
      kind: "in-sync",
    });
  });

  it("treats a version within Go's int64 range as a real conflict (BigInt parity)", () => {
    // 9999999999999999 (~1e16) is above Number.MAX_SAFE_INTEGER but within int64,
    // so Go's strconv.Atoi accepts it and surfaces it as an extra-remote conflict.
    // A Number-based parser would skip it (initial pull); BigInt compares exactly.
    expect(legacyReconcileMigrations(["9999999999999999"], []).kind).toBe("conflict");
  });

  it("skips a version beyond Go's int64 range instead of hanging the scan", () => {
    // A 19-digit value exceeds int64 max (9223372036854775807); Go's Atoi returns a
    // range error and skips it, so the scan can't stall on the exhausted-side pin.
    expect(
      legacyReconcileMigrations(["20240101000000", "9999999999999999999"], ["20240101000000"]),
    ).toEqual({ kind: "in-sync" });
  });
});

describe("legacyListRemoteMigrations (suppress only undefined_table, like Go)", () => {
  const run = (error: LegacyDbExecError) =>
    Effect.runPromiseExit(legacyListRemoteMigrations(failingSession(error)));

  it("treats a missing history table (42P01) as an empty history", async () => {
    const exit = await run(
      new LegacyDbExecError({
        message: 'relation "supabase_migrations.schema_migrations" does not exist',
        code: "42P01",
      }),
    );
    expect(exit).toStrictEqual(Exit.succeed([]));
  });

  it("propagates a malformed table (undefined column 42703) instead of swallowing it", async () => {
    const exit = await run(
      new LegacyDbExecError({ message: 'column "version" does not exist', code: "42703" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("falls back to a relation-not-exist message when no SQLSTATE is surfaced", async () => {
    const exit = await run(
      new LegacyDbExecError({
        message: 'relation "supabase_migrations.schema_migrations" does not exist',
      }),
    );
    expect(exit).toStrictEqual(Exit.succeed([]));
  });

  it("does not swallow a column-not-exist message when no SQLSTATE is surfaced", async () => {
    const exit = await run(new LegacyDbExecError({ message: 'column "version" does not exist' }));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("legacyFindPendingMigrations (Go TestPendingMigrations / TestIgnoreVersionMismatch)", () => {
  it("returns the local paths after the remote count when in sync", () => {
    const local = ["0", "1", "2"].map(mig);
    const result = legacyFindPendingMigrations(local, ["0"]);
    expect(result).toEqual({ kind: "pending", paths: [mig("1"), mig("2")] });
  });

  it("is up to date when an 8-digit and a 14-digit version share a prefix (#6036)", () => {
    // Local files arrive in name order, where `20260420010000_…` precedes
    // `20260420_…` ('0' < '_') — the reverse of the version order
    // `schema_migrations` is read back in.
    const local = ["20260420010000", "20260420"].map(mig);
    const result = legacyFindPendingMigrations(local, ["20260420", "20260420010000"]);
    expect(result).toEqual({ kind: "pending", paths: [] });
  });

  it("flags out-of-order local migrations as missing-remote", () => {
    // local [0,1,2,3], remote [0,2] → unapplied [1] (1 sits before applied 2).
    const local = ["20221201000000", "20221201000001", "20221201000002", "20221201000003"].map(mig);
    const result = legacyFindPendingMigrations(local, ["20221201000000", "20221201000002"]);
    expect(result).toEqual({ kind: "missing-remote", paths: [mig("20221201000001")] });
  });

  it("flags a remote version absent from local as missing-local", () => {
    // local [0,2], remote [0,1,2,3,4] → missing [1,3,4].
    const local = ["20221201000000", "20221201000002"].map(mig);
    const result = legacyFindPendingMigrations(local, [
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
    const result = legacyFindPendingMigrations(local, ["20221201000002", "20221201000004"]);
    expect(result).toEqual({ kind: "missing-local", versions: ["20221201000004"] });
  });
});

describe("legacySuggestMigrationRepair", () => {
  it("lists reverted (remote) then applied (local) repair commands", () => {
    const out = stripAnsi(legacySuggestMigrationRepair(["111"], ["222"]));
    expect(out).toContain("try repairing the migration history table:");
    expect(out).toContain("supabase migration repair --status reverted 111");
    expect(out).toContain("supabase migration repair --status applied 222");
  });
});

describe("legacySuggestRevertHistory", () => {
  it("builds the revert-history suggestion with a trailing newline per line", () => {
    expect(legacySuggestRevertHistory(["0002", "0003"])).toContain(
      "supabase migration repair --status reverted 0002 0003",
    );
    expect(legacySuggestRevertHistory(["0002"])).toMatch(/\n$/u);
    expect(legacySuggestRevertHistory(["0002"])).toContain("supabase db pull");
  });
});

describe("legacyResolveMigrationFile (byte-ordered match, Go's sort.Strings via afero match.go:91)", () => {
  it("picks the UTF-8-byte-first match, not JS's default UTF-16 code-unit order", async () => {
    // A supplementary-plane character (U+1F600, a UTF-16 surrogate pair) alongside a BMP
    // private-use character (U+E000): JS's default `.sort()` (no comparator) ranks the
    // surrogate pair FIRST — its leading high-surrogate code unit (0xD83D) is less than
    // the private-use code unit (0xE000). `sort.Strings` (UTF-8 byte order) ranks the
    // private-use character first instead (0xEE... < 0xF0... in its UTF-8 encoding).
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* legacyResolveMigrationFile(
          fs,
          path,
          "/supabase/migrations",
          "20240101000000",
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(Option.isSome(result) ? result.value : undefined).toBe(
      `/supabase/migrations/${privateUse}`,
    );
  });
});
