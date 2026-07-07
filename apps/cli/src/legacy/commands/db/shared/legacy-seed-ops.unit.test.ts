import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { legacyMatchPattern, legacySeedData } from "./legacy-seed-ops.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

function fakeSeedSession() {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: LegacyDbSession = {
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return Effect.void;
    },
    query: (sql) => {
      calls.push({ kind: "query", sql });
      return Effect.succeed([]);
    },
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

describe("legacyMatchPattern", () => {
  it("matches a literal filename", () => {
    expect(legacyMatchPattern("seed.sql", "seed.sql")).toBe(true);
    expect(legacyMatchPattern("seed.sql", "other.sql")).toBe(false);
  });

  it("matches `*` against any run of characters", () => {
    expect(legacyMatchPattern("*.sql", "seed.sql")).toBe(true);
    expect(legacyMatchPattern("*.sql", "0001_init.sql")).toBe(true);
    expect(legacyMatchPattern("*.sql", "seed.txt")).toBe(false);
    expect(legacyMatchPattern("seed.*", "seed.sql")).toBe(true);
  });

  it("matches `?` against exactly one character", () => {
    expect(legacyMatchPattern("seed?.sql", "seed1.sql")).toBe(true);
    expect(legacyMatchPattern("seed?.sql", "seed12.sql")).toBe(false);
    expect(legacyMatchPattern("seed?.sql", "seed.sql")).toBe(false);
  });

  it("matches character classes with ranges and negation", () => {
    expect(legacyMatchPattern("seed[0-9].sql", "seed5.sql")).toBe(true);
    expect(legacyMatchPattern("seed[0-9].sql", "seedx.sql")).toBe(false);
    expect(legacyMatchPattern("seed[!0-9].sql", "seedx.sql")).toBe(true);
    expect(legacyMatchPattern("seed[!0-9].sql", "seed5.sql")).toBe(false);
  });

  it("honors backslash escapes", () => {
    expect(legacyMatchPattern("seed\\*.sql", "seed*.sql")).toBe(true);
    expect(legacyMatchPattern("seed\\*.sql", "seedx.sql")).toBe(false);
  });

  it("collapses consecutive stars", () => {
    expect(legacyMatchPattern("**.sql", "seed.sql")).toBe(true);
  });
});

const runSeed = (
  session: LegacyDbSession,
  workdir: string,
  seeds: ReadonlyArray<{ readonly path: string; readonly hash: string; readonly dirty: boolean }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacySeedData(
      session,
      fs,
      workdir,
      path,
      seeds,
      (message) => new TestError({ message }),
    );
  }).pipe(Effect.provide(mockOutput({ format: "text" }).layer), Effect.provide(BunServices.layer));

describe("legacySeedData (dirty parse)", () => {
  it.effect("fails on an unreadable dirty seed instead of refreshing its hash", () => {
    // Go's `ExecBatchWithCache` reads + parses the file UNCONDITIONALLY before the
    // dirty check, so a dirty seed pointing at a missing file must fail (and leave
    // the previous hash) rather than silently upserting the new hash.
    const dir = mkdtempSync(join(tmpdir(), "legacy-seed-"));
    const { session, calls } = fakeSeedSession();
    return runSeed(session, dir, [{ path: "missing.sql", hash: "newhash", dirty: true }]).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          // The hash upsert is a `query`; the only execs that ran are the
          // schema/table creation (whose DDL also mentions `seed_files`), so assert
          // no `query` ran rather than substring-matching the table name.
          expect(calls.some((c) => c.kind === "query")).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("refreshes the hash for a dirty seed that parses, without running statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-seed-"));
    writeFileSync(join(dir, "data.sql"), "insert into t values (1);");
    const { session, calls } = fakeSeedSession();
    return runSeed(session, dir, [{ path: "data.sql", hash: "newhash", dirty: true }]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Go's CreateSeedTable scopes the lock timeout to the DDL transaction
          // (BEGIN + SET LOCAL + COMMIT) so it never leaks into the seed SQL below.
          expect(calls.some((c) => c.sql === "SET LOCAL lock_timeout = '4s'")).toBe(true);
          // Statements are NOT executed for a dirty seed, but the hash IS upserted.
          expect(calls.some((c) => c.sql.includes("insert into t"))).toBe(false);
          expect(calls.some((c) => c.kind === "query" && c.sql.includes("seed_files"))).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
