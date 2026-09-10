import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import type { DbSession } from "./db-connection.service.ts";
import { getPendingSeeds, seedData } from "./seed-ops.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

function fakeSeedSession(opts: { restoreRoleSql?: string } = {}) {
  const calls: Array<{ kind: "exec" | "query"; sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: DbSession = {
    ...(opts.restoreRoleSql === undefined ? {} : { restoreRoleSql: opts.restoreRoleSql }),
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return Effect.void;
    },
    execBatch: (statements) => {
      for (const { sql } of statements) calls.push({ kind: "exec", sql });
      return Effect.void;
    },
    query: (sql, params) => {
      calls.push({ kind: "query", sql, ...(params === undefined ? {} : { params }) });
      return Effect.succeed([]);
    },
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

// Exercises that `getPendingSeeds`'s glob resolution actually uses `pathMatch`
// (`../../../shared/path-match.ts`) end to end; pattern-matching semantics are covered by
// `path-match.unit.test.ts`.
describe("getPendingSeeds (glob character classes)", () => {
  it.effect(
    "treats a leading `!` in a bracket class as literal, not negation (Go path.Match parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "seed-glob-"));
      writeFileSync(join(dir, "a.sql"), "select 1;");
      writeFileSync(join(dir, "b.sql"), "select 2;");
      const { session } = fakeSeedSession();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // `[!a]` is a positive class of `!` and `a`; only a leading `^` negates.
        const pending = yield* getPendingSeeds(session, fs, path, ["[!a].sql"], dir);
        expect(pending.map((seed) => seed.path)).toEqual(["a.sql"]);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "warns Go's bad-pattern message for an unterminated bracket class, not a bogus no-match",
    () => {
      // An unclosed `[` is malformed, so `fs.Glob` reports a syntax error, not a bogus
      // "no files matched" for a well-formed-but-empty pattern.
      const dir = mkdtempSync(join(tmpdir(), "seed-glob-"));
      const { session } = fakeSeedSession();
      const out = mockOutput({ format: "text" });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pending = yield* getPendingSeeds(session, fs, path, ["seed[.sql"], dir);
        expect(pending).toEqual([]);
        expect(out.rawChunks.map((c) => c.text).join("")).toContain(
          "failed to glob files: syntax error in pattern",
        );
        rmSync(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(out.layer), Effect.provide(BunServices.layer));
    },
  );
});

const runSeed = (
  session: DbSession,
  workdir: string,
  seeds: ReadonlyArray<{ readonly path: string; readonly hash: string; readonly dirty: boolean }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* seedData(
      session,
      fs,
      workdir,
      path,
      seeds,
      (message) => new TestError({ message }),
    );
  }).pipe(Effect.provide(mockOutput({ format: "text" }).layer), Effect.provide(BunServices.layer));

describe("seedData (dirty parse)", () => {
  it.effect("fails on an unreadable dirty seed instead of refreshing its hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const { session, calls } = fakeSeedSession();
    return runSeed(session, dir, [{ path: "missing.sql", hash: "newhash", dirty: true }]).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.some((c) => c.kind === "query" && c.params !== undefined)).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "rejects an oversized seed statement when SUPABASE_SCANNER_BUFFER_SIZE is configured (Go SeedFile.ExecBatchWithCache parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "seed-scanner-"));
      // The seed text must exceed the 4096-byte scanner floor regardless of the configured
      // limit (see migration-apply.unit.test.ts's equivalent case).
      writeFileSync(join(dir, "big.sql"), `select '${"x".repeat(5000)}';`);
      const { session, calls } = fakeSeedSession();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "100b";
      return runSeed(session, dir, [{ path: "big.sql", hash: "newhash", dirty: false }]).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            expect(calls.some((c) => c.sql.includes("select"))).toBe(false);
            rmSync(dir, { recursive: true, force: true });
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
          }),
        ),
      );
    },
  );

  it.effect("refreshes the hash for a dirty seed that parses, without running statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "data.sql"), "insert into t values (1);");
    const { session, calls } = fakeSeedSession();
    return runSeed(session, dir, [{ path: "data.sql", hash: "newhash", dirty: true }]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.some((c) => c.sql === "SET LOCAL lock_timeout = '4s'")).toBe(true);
          expect(calls.some((c) => c.sql.includes("insert into t"))).toBe(false);
          expect(
            calls.some(
              (c) => c.kind === "query" && c.params !== undefined && c.sql.includes("seed_files"),
            ),
          ).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("re-asserts the stepped-down role before the seed_files upsert", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "data.sql"), "set role r;\ninsert into t values (1);\nreset role;");
    const { session, calls } = fakeSeedSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return runSeed(session, dir, [{ path: "data.sql", hash: "h", dirty: false }]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sqls = calls.map((c) => c.sql);
          const restoreAt = sqls.indexOf("SET SESSION ROLE postgres");
          const upsertAt = calls.findIndex(
            (c) => c.kind === "query" && c.params !== undefined && c.sql.includes("seed_files"),
          );
          expect(restoreAt).toBeGreaterThan(sqls.indexOf("reset role"));
          expect(upsertAt).toBeGreaterThan(restoreAt);
          expect(sqls.lastIndexOf("COMMIT")).toBeGreaterThan(upsertAt);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("restores the role right after a mid-seed reset, before later statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "data.sql"), "set role r;\nreset role;\ninsert into t values (1);");
    const { session, calls } = fakeSeedSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return runSeed(session, dir, [{ path: "data.sql", hash: "h", dirty: false }]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sqls = calls.map((c) => c.sql);
          const resetAt = sqls.indexOf("reset role");
          expect(sqls[resetAt + 1]).toBe("SET SESSION ROLE postgres");
          expect(sqls.indexOf("insert into t values (1)")).toBeGreaterThan(resetAt + 1);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
