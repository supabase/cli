import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import type { DbSession } from "./db-connection.service.ts";
import { applySeedFiles, MigrationSeedError } from "./seed.ts";

function fakeSession() {
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: DbSession = {
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

const tempDir = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    return { fs, path, dir };
  });

const run = (
  session: DbSession,
  workdir: string,
  sqlPaths: ReadonlyArray<string>,
  out: ReturnType<typeof mockOutput>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* applySeedFiles(session, fs, path, workdir, { enabled: true, sqlPaths });
  }).pipe(Effect.provide(out.layer));

layer(NodeServices.layer)("applySeedFiles seed glob", (it) => {
  it.effect("treats a backslash escape as a glob metacharacter (matches the real file)", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempDir("seed-");
      yield* fs.writeFileString(path.join(dir, "seed.sql"), "insert into t values (1);");
      const { session, queries } = fakeSession();
      const out = mockOutput();
      yield* run(session, dir, ["seed\\.sql"], out);
      const upsert = queries.find((q) =>
        q.sql.includes("INSERT INTO supabase_migrations.seed_files"),
      );
      expect(upsert?.params?.[0]).toBe("seed.sql");
      expect(out.rawChunks.map((c) => c.text)).toContain("Seeding data from seed.sql...\n");
    }),
  );

  it.effect("warns (no match) when a backslash-escaped pattern's literal file is absent", () =>
    Effect.gen(function* () {
      const { dir } = yield* tempDir("seed-");
      const { session, queries } = fakeSession();
      const out = mockOutput();
      yield* run(session, dir, ["missing\\.sql"], out);
      expect(queries.some((q) => q.sql.includes("seed_files"))).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: "no files matched pattern: missing\\.sql",
        }),
      );
    }),
  );

  it.effect(
    "expands a matched directory to its sorted, regular .sql files (Go's Glob.SQLFiles)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempDir("seed-");
        yield* fs.makeDirectory(path.join(dir, "seeds"));
        yield* fs.writeFileString(path.join(dir, "seeds", "b.sql"), "insert into t values (2);");
        yield* fs.writeFileString(path.join(dir, "seeds", "a.sql"), "insert into t values (1);");
        yield* fs.writeFileString(path.join(dir, "seeds", "README.md"), "not a seed file");
        const { session, queries } = fakeSession();
        const out = mockOutput();
        yield* run(session, dir, ["seeds"], out);
        const upserts = queries.filter((q) =>
          q.sql.includes("INSERT INTO supabase_migrations.seed_files"),
        );
        expect(upserts.map((q) => q.params?.[0])).toEqual(["seeds/a.sql", "seeds/b.sql"]);
        expect(out.rawChunks.map((c) => c.text)).toEqual([
          "Seeding data from seeds/a.sql...\n",
          "Seeding data from seeds/b.sql...\n",
        ]);
      }),
  );
});

layer(NodeServices.layer)("applySeedFiles scanner buffer size", (it) => {
  it.effect(
    "rejects an oversized seed statement when SUPABASE_SCANNER_BUFFER_SIZE is configured (Go SeedFile.ExecBatchWithCache parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempDir("seed-scanner-");
        // The seed text must exceed the 4096-byte scanner floor regardless of the configured
        // limit (see migration-apply.unit.test.ts's equivalent case).
        yield* fs.writeFileString(
          path.join(dir, "big.sql"),
          `insert into t values ('${"x".repeat(5000)}');`,
        );
        const { session, queries } = fakeSession();
        const error = yield* run(session, dir, ["big.sql"], mockOutput()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(MigrationSeedError);
        expect(error.message).toBe(
          "bufio.Scanner: token too long\nAfter statement 0: \nTry setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is 0KB)",
        );
        expect(queries.some((q) => q.sql.includes("insert into t"))).toBe(false);
      }).pipe((body) => withConfigEnv({ SUPABASE_SCANNER_BUFFER_SIZE: "100b" }, body)),
  );
});

layer(NodeServices.layer)("applySeedFiles stepped-down session", (it) => {
  it.effect("restores the role right after a reset and before the seed_files upsert", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempDir("seed-");
      yield* fs.writeFileString(
        path.join(dir, "seed.sql"),
        "set role r;\nreset role;\ninsert into t values (1);",
      );
      const calls: Array<string> = [];
      const session: DbSession = {
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
      yield* run(session, dir, ["seed.sql"], out);
      const resetAt = calls.indexOf("reset role");
      const upsertAt = calls.findIndex((sql) =>
        sql.includes("INSERT INTO supabase_migrations.seed_files"),
      );
      expect(calls[resetAt + 1]).toBe("SET SESSION ROLE postgres");
      expect(upsertAt).toBeGreaterThan(resetAt);
      expect(out.stderrText).not.toContain("WARN:");
    }),
  );
});
