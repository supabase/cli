import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyGetPendingSeeds, legacySeedData } from "./legacy-seed-ops.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

function fakeSeedSession(opts: { restoreRoleSql?: string } = {}) {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: LegacyDbSession = {
    ...(opts.restoreRoleSql === undefined ? {} : { restoreRoleSql: opts.restoreRoleSql }),
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return Effect.void;
    },
    execBatch: (statements) => {
      for (const { sql } of statements) calls.push({ kind: "exec", sql });
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

const withTempDirectory = <A>(
  prefix: string,
  use: (
    directory: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, Error, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(directory),
      (root) => use(root, fs, path),
      (root) => fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie);

// Glob matching itself is `legacyPathMatch` (`../../../shared/legacy-path-match.ts`),
// a faithful port of Go's `path.Match` already covered by
// `legacy-path-match.unit.test.ts` (including the `^`-only negation / `!`-is-literal
// rule this file used to duplicate — and get wrong — in a local `legacyMatchPattern`).
// This exercises that the seed pipeline's own glob resolution (`legacyGetPendingSeeds`)
// actually uses it end to end, per `config.Glob.Files` → `fs.Glob` → `path.Match`.
describe("legacyGetPendingSeeds (glob character classes)", () => {
  it.effect(
    "treats a leading `!` in a bracket class as literal, not negation (Go path.Match parity)",
    () => {
      const { session } = fakeSeedSession();
      return withTempDirectory("legacy-seed-glob-", (dir, fs, path) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(path.join(dir, "a.sql"), "select 1;");
          yield* fs.writeFileString(path.join(dir, "b.sql"), "select 2;");
          // `[!a]` is a positive class of the literal members `!` and `a` — only a
          // leading `^` negates. So this pattern matches `a.sql`, not `b.sql` (the old
          // shell-style bug negated on `!` too, and would have matched `b.sql` instead).
          const pending = yield* legacyGetPendingSeeds(session, fs, path, ["[!a].sql"], dir);
          expect(pending.map((seed) => seed.path)).toEqual(["a.sql"]);
        }).pipe(
          Effect.provide(Layer.mergeAll(mockOutput({ format: "text" }).layer, BunServices.layer)),
        ),
      );
    },
  );

  it.effect(
    "warns Go's bad-pattern message for an unterminated bracket class, not a bogus no-match",
    () => {
      // An unclosed `[` is malformed per Go's `path.Match` grammar (`ErrBadPattern`), which
      // `fs.Glob` reports as `failed to glob files: syntax error in pattern` — not the
      // generic `no files matched pattern` a same-shaped but well-formed glob would get.
      const { session } = fakeSeedSession();
      const out = mockOutput({ format: "text" });
      return withTempDirectory("legacy-seed-glob-", (dir, fs, path) =>
        Effect.gen(function* () {
          const pending = yield* legacyGetPendingSeeds(session, fs, path, ["seed[.sql"], dir);
          expect(pending).toEqual([]);
          expect(out.rawChunks.map((c) => c.text).join("")).toContain(
            "failed to glob files: syntax error in pattern",
          );
        }).pipe(Effect.provide(Layer.mergeAll(out.layer, BunServices.layer))),
      );
    },
  );
});

const runSeed = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  workdir: string,
  path: Path.Path,
  seeds: ReadonlyArray<{ readonly path: string; readonly hash: string; readonly dirty: boolean }>,
) =>
  legacySeedData(
    session,
    fs,
    workdir,
    path,
    seeds,
    {},
    (message) => new TestError({ message }),
  ).pipe(Effect.provide(mockOutput({ format: "text" }).layer));

describe("legacySeedData (dirty parse)", () => {
  it.effect("fails on an unreadable dirty seed instead of refreshing its hash", () => {
    // `ExecBatchWithCache` reads + parses the file UNCONDITIONALLY before the
    // dirty check, so a dirty seed pointing at a missing file must fail (and leave
    // the previous hash) rather than silently upserting the new hash.
    const { session, calls } = fakeSeedSession();
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      runSeed(session, fs, dir, path, [{ path: "missing.sql", hash: "newhash", dirty: true }]).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            // The hash upsert is a `query`; the only execs that ran are the
            // schema/table creation (whose DDL also mentions `seed_files`), so assert
            // no `query` ran rather than substring-matching the table name.
            expect(calls.some((c) => c.kind === "query")).toBe(false);
          }),
        ),
      ),
    );
  });

  it.effect(
    "rejects an oversized seed statement when SUPABASE_SCANNER_BUFFER_SIZE is configured (Go SeedFile.ExecBatchWithCache parity)",
    () => {
      // Go's SeedFile.ExecBatchWithCache parses through the same parseFile every
      // other file type does, so an oversized statement must abort the seed run —
      // same as legacy-migration-apply.unit.test.ts's equivalent case for migrations.
      // Raw text must exceed the 4096-byte floor Go's bufio.Scanner starts at
      // regardless of the configured limit (see legacy-migration-apply.unit.test.ts's
      // equivalent case for the exact same 4096-byte floor).
      const { session, calls } = fakeSeedSession();
      return withTempDirectory("legacy-seed-scanner-", (dir, fs, path) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(path.join(dir, "big.sql"), `select '${"x".repeat(5000)}';`);
          const exit = yield* legacySeedData(
            session,
            fs,
            dir,
            path,
            [{ path: "big.sql", hash: "newhash", dirty: false }],
            { SUPABASE_SCANNER_BUFFER_SIZE: "100b" },
            (message) => new TestError({ message }),
          ).pipe(Effect.provide(mockOutput({ format: "text" }).layer), Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.some((c) => c.sql.includes("select"))).toBe(false);
        }),
      );
    },
  );

  it.effect("refreshes the hash for a dirty seed that parses, without running statements", () => {
    const { session, calls } = fakeSeedSession();
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(dir, "data.sql"), "insert into t values (1);");
        yield* runSeed(session, fs, dir, path, [
          { path: "data.sql", hash: "newhash", dirty: true },
        ]);
        // Go's CreateSeedTable scopes the lock timeout to the DDL transaction
        // (BEGIN + SET LOCAL + COMMIT) so it never leaks into the seed SQL below.
        expect(calls.some((c) => c.sql === "SET LOCAL lock_timeout = '4s'")).toBe(true);
        // Statements are NOT executed for a dirty seed, but the hash IS upserted.
        expect(calls.some((c) => c.sql.includes("insert into t"))).toBe(false);
        expect(calls.some((c) => c.kind === "query" && c.sql.includes("seed_files"))).toBe(true);
      }),
    );
  });

  it.effect("re-asserts the stepped-down role before the seed_files upsert", () => {
    // A seed's own `reset role` reverts a stepped-down session to the login role,
    // which used to fail the CLI's hash upsert with 42501 (supabase/cli#6236).
    const { session, calls } = fakeSeedSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          path.join(dir, "data.sql"),
          "set role r;\ninsert into t values (1);\nreset role;",
        );
        yield* runSeed(session, fs, dir, path, [{ path: "data.sql", hash: "h", dirty: false }]);
        const sqls = calls.map((c) => c.sql);
        const restoreAt = sqls.indexOf("SET SESSION ROLE postgres");
        const upsertAt = calls.findIndex((c) => c.kind === "query" && c.sql.includes("seed_files"));
        expect(restoreAt).toBeGreaterThan(sqls.indexOf("reset role"));
        expect(upsertAt).toBeGreaterThan(restoreAt);
        expect(sqls.lastIndexOf("COMMIT")).toBeGreaterThan(upsertAt);
      }),
    );
  });

  it.effect("restores the role right after a mid-seed reset, before later statements", () => {
    const { session, calls } = fakeSeedSession({ restoreRoleSql: "SET SESSION ROLE postgres" });
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          path.join(dir, "data.sql"),
          "set role r;\nreset role;\ninsert into t values (1);",
        );
        yield* runSeed(session, fs, dir, path, [{ path: "data.sql", hash: "h", dirty: false }]);
        const sqls = calls.map((c) => c.sql);
        const resetAt = sqls.indexOf("reset role");
        // Injected immediately, so the following insert runs as postgres again.
        expect(sqls[resetAt + 1]).toBe("SET SESSION ROLE postgres");
        expect(sqls.indexOf("insert into t values (1)")).toBeGreaterThan(resetAt + 1);
      }),
    );
  });
});
