import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyApplySeedFiles } from "./legacy-seed.ts";

function fakeSession() {
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: LegacyDbSession = {
    exec: () => Effect.void,
    execBatch: () => Effect.void,
    query: (sql, params) =>
      Effect.sync(() => {
        queries.push({ sql, params });
        return [];
      }),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, queries };
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

describe("legacyApplySeedFiles seed glob", () => {
  it.effect("treats a backslash escape as a glob metacharacter (matches the real file)", () => {
    // `io/fs.hasMeta` counts `\` (escape), so `seed\.sql` globs via path.Match
    // and matches the literal `seed.sql` — not a file named `seed\.sql`.
    const { session, queries } = fakeSession();
    const out = mockOutput();
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(dir, "seed.sql"), "insert into t values (1);");
        yield* legacyApplySeedFiles(
          session,
          fs,
          path,
          dir,
          { enabled: true, sqlPaths: ["seed\\.sql"] },
          {},
        );
        const upsert = queries.find((q) =>
          q.sql.includes("INSERT INTO supabase_migrations.seed_files"),
        );
        expect(upsert?.params?.[0]).toBe("seed.sql");
        expect(out.rawChunks.map((c) => c.text)).toContain("Seeding data from seed.sql...\n");
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer))),
    );
  });

  it.effect("warns (no match) when a backslash-escaped pattern's literal file is absent", () => {
    // `missing\.sql` escapes to the literal `missing.sql`; with no such file it matches
    // nothing and Go emits a single `no files matched pattern` warning.
    const { session, queries } = fakeSession();
    const out = mockOutput();
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      legacyApplySeedFiles(
        session,
        fs,
        path,
        dir,
        { enabled: true, sqlPaths: ["missing\\.sql"] },
        {},
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(queries.some((q) => q.sql.includes("seed_files"))).toBe(false);
            expect(out.rawChunks.map((c) => c.text).join("")).toContain(
              "no files matched pattern: missing\\.sql",
            );
          }),
        ),
        Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)),
      ),
    );
  });

  it.effect(
    "expands a matched directory to its sorted, regular .sql files (Go's Glob.SQLFiles)",
    () => {
      // `GetPendingSeeds` calls `locals.SQLFiles(fsys)` — the SAME `Glob.SQLFiles` method
      // `db.migrations.schema_paths` resolves through — which expands a directory match to its
      // recursively-walked, sorted `.sql` files rather than treating the directory itself as a
      // seed file.
      const { session, queries } = fakeSession();
      const out = mockOutput();
      return withTempDirectory("legacy-seed-", (dir, fs, path) =>
        Effect.gen(function* () {
          const seeds = path.join(dir, "seeds");
          yield* fs.makeDirectory(seeds);
          yield* fs.writeFileString(path.join(seeds, "b.sql"), "insert into t values (2);");
          yield* fs.writeFileString(path.join(seeds, "a.sql"), "insert into t values (1);");
          yield* fs.writeFileString(path.join(seeds, "README.md"), "not a seed file");
          yield* legacyApplySeedFiles(
            session,
            fs,
            path,
            dir,
            { enabled: true, sqlPaths: ["seeds"] },
            {},
          );
          const upserts = queries.filter((q) =>
            q.sql.includes("INSERT INTO supabase_migrations.seed_files"),
          );
          expect(upserts.map((q) => q.params?.[0])).toEqual(["seeds/a.sql", "seeds/b.sql"]);
          expect(out.rawChunks.map((c) => c.text)).toEqual([
            "Seeding data from seeds/a.sql...\n",
            "Seeding data from seeds/b.sql...\n",
          ]);
        }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer))),
      );
    },
  );
});

describe("legacyApplySeedFiles scanner buffer size", () => {
  it.effect(
    "rejects an oversized seed statement when SUPABASE_SCANNER_BUFFER_SIZE is configured (Go SeedFile.ExecBatchWithCache parity)",
    () => {
      // Ports the same `parseFile` every migration/globals/schema-file caller goes
      // through (see `checkScannerBufferSize`'s doc comment), so an oversized
      // statement must abort here too, not execute silently.
      // Raw text must exceed the 4096-byte floor Go's bufio.Scanner starts at
      // regardless of the configured limit (see legacy-migration-apply.unit.test.ts's
      // equivalent case for the exact same 4096-byte floor).
      const { session, queries } = fakeSession();
      const out = mockOutput();
      return withTempDirectory("legacy-seed-scanner-", (dir, fs, path) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            path.join(dir, "big.sql"),
            `insert into t values ('${"x".repeat(5000)}');`,
          );
          const exit = yield* legacyApplySeedFiles(
            session,
            fs,
            path,
            dir,
            { enabled: true, sqlPaths: ["big.sql"] },
            { SUPABASE_SCANNER_BUFFER_SIZE: "100b" },
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(queries.some((q) => q.sql.includes("insert into t"))).toBe(false);
        }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer))),
      );
    },
  );
});

describe("legacyApplySeedFiles stepped-down session", () => {
  it.effect("restores the role right after a reset and before the seed_files upsert", () => {
    const calls: Array<string> = [];
    const session: LegacyDbSession = {
      restoreRoleSql: "SET SESSION ROLE postgres",
      exec: (sql) =>
        Effect.sync(() => {
          calls.push(sql);
        }),
      execBatch: () => Effect.void,
      query: (sql) =>
        Effect.sync(() => {
          calls.push(sql);
          return [];
        }),
      extensionExists: () => Effect.succeed(false),
      copyToCsv: () => Effect.succeed(new Uint8Array()),
      queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
    };
    const out = mockOutput();
    return withTempDirectory("legacy-seed-", (dir, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          path.join(dir, "seed.sql"),
          "set role r;\nreset role;\ninsert into t values (1);",
        );
        yield* legacyApplySeedFiles(
          session,
          fs,
          path,
          dir,
          { enabled: true, sqlPaths: ["seed.sql"] },
          {},
        );
        const resetAt = calls.indexOf("reset role");
        const upsertAt = calls.findIndex((sql) =>
          sql.includes("INSERT INTO supabase_migrations.seed_files"),
        );
        // Injected immediately after the reset, so the following insert (and
        // everything else in the file) runs as postgres again.
        expect(calls[resetAt + 1]).toBe("SET SESSION ROLE postgres");
        expect(upsertAt).toBeGreaterThan(resetAt);
        expect(out.stderrText).not.toContain("WARN:");
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer))),
    );
  });
});
