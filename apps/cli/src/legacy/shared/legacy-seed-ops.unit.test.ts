import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyGetPendingSeeds, legacySeedData } from "./legacy-seed-ops.ts";

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

// Glob matching itself is `legacyPathMatch` (`../../../shared/legacy-path-match.ts`),
// a faithful port of Go's `path.Match` already covered by
// `legacy-path-match.unit.test.ts` (including the `^`-only negation / `!`-is-literal
// rule this file used to duplicate — and get wrong — in a local `legacyMatchPattern`).
// This exercises that the seed pipeline's own glob resolution (`legacyGetPendingSeeds`)
// actually uses it end to end, per Go's `config.Glob.Files` → `fs.Glob` → `path.Match`.
describe("legacyGetPendingSeeds (glob character classes)", () => {
  it.effect(
    "treats a leading `!` in a bracket class as literal, not negation (Go path.Match parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-seed-glob-"));
      writeFileSync(join(dir, "a.sql"), "select 1;");
      writeFileSync(join(dir, "b.sql"), "select 2;");
      const { session } = fakeSeedSession();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Go's `[!a]` is a positive class of the literal members `!` and `a` — only a
        // leading `^` negates. So this pattern matches `a.sql`, not `b.sql` (the old
        // shell-style bug negated on `!` too, and would have matched `b.sql` instead).
        const pending = yield* legacyGetPendingSeeds(session, fs, path, ["[!a].sql"], dir);
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
      // An unclosed `[` is malformed per Go's `path.Match` grammar (`ErrBadPattern`), which
      // `fs.Glob` reports as `failed to glob files: syntax error in pattern` — not the
      // generic `no files matched pattern` a same-shaped but well-formed glob would get.
      const dir = mkdtempSync(join(tmpdir(), "legacy-seed-glob-"));
      const { session } = fakeSeedSession();
      const out = mockOutput({ format: "text" });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pending = yield* legacyGetPendingSeeds(session, fs, path, ["seed[.sql"], dir);
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
