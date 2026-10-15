import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
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

const tempDir = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    return { fs, path, dir };
  });

// Exercises that `getPendingSeeds`'s glob resolution actually uses `pathMatch`
// (`../../../shared/path-match.ts`) end to end; pattern-matching semantics are covered by
// `path-match.unit.test.ts`.
layer(BunServices.layer)("getPendingSeeds (glob character classes)", (it) => {
  it.effect("treats a leading `!` in a bracket class as literal, not negation", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempDir("seed-glob-");
      yield* fs.writeFileString(path.join(dir, "a.sql"), "select 1;");
      yield* fs.writeFileString(path.join(dir, "b.sql"), "select 2;");
      const { session } = fakeSeedSession();
      // `[!a]` is a positive class of `!` and `a`; only a leading `^` negates.
      const pending = yield* getPendingSeeds(session, fs, path, ["[!a].sql"], dir);
      expect(pending.map((seed) => seed.path)).toEqual(["a.sql"]);
    }).pipe(Effect.provide(mockOutput({ format: "text" }).layer)),
  );

  it.effect(
    "warns the bad-pattern message for an unterminated bracket class, not a bogus no-match",
    () => {
      // An unclosed `[` is malformed, so `fs.Glob` reports a syntax error, not a bogus
      // "no files matched" for a well-formed-but-empty pattern.
      const { session } = fakeSeedSession();
      const out = mockOutput({ format: "text" });
      return Effect.gen(function* () {
        const { fs, path, dir } = yield* tempDir("seed-glob-");
        const pending = yield* getPendingSeeds(session, fs, path, ["seed[.sql"], dir);
        expect(pending).toEqual([]);
        expect(out.rawChunks.map((c) => c.text).join("")).toContain(
          "failed to glob files: syntax error in pattern",
        );
      }).pipe(Effect.provide(out.layer));
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
  }).pipe(Effect.provide(mockOutput({ format: "text" }).layer));

layer(BunServices.layer)("seedData (dirty parse)", (it) => {
  it.effect("fails on an unreadable dirty seed instead of refreshing its hash", () =>
    Effect.gen(function* () {
      const { dir } = yield* tempDir("seed-");
      const { session, calls } = fakeSeedSession();
      const exit = yield* runSeed(session, dir, [
        { path: "missing.sql", hash: "newhash", dirty: true },
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls.some((c) => c.kind === "query" && c.params !== undefined)).toBe(false);
    }),
  );

  it.effect(
    "rejects an oversized seed statement when SUPABASE_SCANNER_BUFFER_SIZE is configured",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempDir("seed-scanner-");
        // The seed text must exceed the 4096-byte scanner floor regardless of the configured
        // limit (see migration-apply.unit.test.ts's equivalent case).
        yield* fs.writeFileString(path.join(dir, "big.sql"), `select '${"x".repeat(5000)}';`);
        const { session, calls } = fakeSeedSession();
        const error = yield* runSeed(session, dir, [
          { path: "big.sql", hash: "newhash", dirty: false },
        ]).pipe(Effect.flip);
        expect(error.message).toBe(
          "scanner: token too long\nAfter statement 0: \nTry setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is 0KB)",
        );
        expect(calls.some((c) => c.sql.includes("select"))).toBe(false);
      }).pipe((body) => withConfigEnv({ SUPABASE_SCANNER_BUFFER_SIZE: "100b" }, body)),
  );

  it.effect("refreshes the hash for a dirty seed that parses, without running statements", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempDir("seed-");
      yield* fs.writeFileString(path.join(dir, "data.sql"), "insert into t values (1);");
      const { session, calls } = fakeSeedSession();
      yield* runSeed(session, dir, [{ path: "data.sql", hash: "newhash", dirty: true }]);
      expect(calls.some((c) => c.sql === "SET LOCAL lock_timeout = '4s'")).toBe(true);
      expect(calls.some((c) => c.sql.includes("insert into t"))).toBe(false);
      expect(
        calls.some(
          (c) => c.kind === "query" && c.params !== undefined && c.sql.includes("seed_files"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("re-asserts the stepped-down role before the seed_files upsert", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempDir("seed-");
      yield* fs.writeFileString(
        path.join(dir, "data.sql"),
        "set role r;\ninsert into t values (1);\nreset role;",
      );
      const { session, calls } = fakeSeedSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
      yield* runSeed(session, dir, [{ path: "data.sql", hash: "h", dirty: false }]);
      const sqls = calls.map((c) => c.sql);
      const restoreAt = sqls.indexOf("SET SESSION ROLE postgres");
      const upsertAt = calls.findIndex(
        (c) => c.kind === "query" && c.params !== undefined && c.sql.includes("seed_files"),
      );
      expect(restoreAt).toBeGreaterThan(sqls.indexOf("reset role"));
      expect(upsertAt).toBeGreaterThan(restoreAt);
      expect(sqls.lastIndexOf("COMMIT")).toBeGreaterThan(upsertAt);
    }),
  );

  it.effect("restores the role right after a mid-seed reset, before later statements", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempDir("seed-");
      yield* fs.writeFileString(
        path.join(dir, "data.sql"),
        "set role r;\nreset role;\ninsert into t values (1);",
      );
      const { session, calls } = fakeSeedSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
      yield* runSeed(session, dir, [{ path: "data.sql", hash: "h", dirty: false }]);
      const sqls = calls.map((c) => c.sql);
      const resetAt = sqls.indexOf("reset role");
      expect(sqls[resetAt + 1]).toBe("SET SESSION ROLE postgres");
      expect(sqls.indexOf("insert into t values (1)")).toBeGreaterThan(resetAt + 1);
    }),
  );
});
