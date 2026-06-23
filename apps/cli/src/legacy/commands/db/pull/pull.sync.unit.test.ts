import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyListRemoteMigrations,
  legacyReconcileMigrations,
  legacySuggestMigrationRepair,
} from "./pull.sync.ts";

/** Minimal session whose `query` fails with the given error. */
const failingSession = (error: LegacyDbExecError): LegacyDbSession => ({
  exec: () => Effect.die("unused"),
  query: () => Effect.fail(error),
  extensionExists: () => Effect.die("unused"),
  copyToCsv: () => Effect.die("unused"),
  queryRaw: () => Effect.die("unused"),
});

// Strip ANSI so the bold repair suggestions compare regardless of TTY colour.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

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

describe("legacySuggestMigrationRepair", () => {
  it("lists reverted (remote) then applied (local) repair commands", () => {
    const out = stripAnsi(legacySuggestMigrationRepair(["111"], ["222"]));
    expect(out).toContain("try repairing the migration history table:");
    expect(out).toContain("supabase migration repair --status reverted 111");
    expect(out).toContain("supabase migration repair --status applied 222");
  });
});
