import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import type { DbSession } from "./db-connection.service.ts";
import { applySeedFiles } from "./seed.ts";

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
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)));

describe("applySeedFiles seed glob", () => {
  it.effect("treats a backslash escape as a glob metacharacter (matches the real file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "seed.sql"), "insert into t values (1);");
    const { session, queries } = fakeSession();
    const out = mockOutput();
    return run(session, dir, ["seed\\.sql"], out).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const upsert = queries.find((q) =>
            q.sql.includes("INSERT INTO supabase_migrations.seed_files"),
          );
          expect(upsert?.params?.[0]).toBe("seed.sql");
          expect(out.rawChunks.map((c) => c.text)).toContain("Seeding data from seed.sql...\n");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("warns (no match) when a backslash-escaped pattern's literal file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const { session, queries } = fakeSession();
    const out = mockOutput();
    return run(session, dir, ["missing\\.sql"], out).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(queries.some((q) => q.sql.includes("seed_files"))).toBe(false);
          expect(out.rawChunks.map((c) => c.text).join("")).toContain(
            "no files matched pattern: missing\\.sql",
          );
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "expands a matched directory to its sorted, regular .sql files (Go's Glob.SQLFiles)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "seed-"));
      mkdirSync(join(dir, "seeds"));
      writeFileSync(join(dir, "seeds", "b.sql"), "insert into t values (2);");
      writeFileSync(join(dir, "seeds", "a.sql"), "insert into t values (1);");
      writeFileSync(join(dir, "seeds", "README.md"), "not a seed file");
      const { session, queries } = fakeSession();
      const out = mockOutput();
      return run(session, dir, ["seeds"], out).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const upserts = queries.filter((q) =>
              q.sql.includes("INSERT INTO supabase_migrations.seed_files"),
            );
            expect(upserts.map((q) => q.params?.[0])).toEqual(["seeds/a.sql", "seeds/b.sql"]);
            expect(out.rawChunks.map((c) => c.text)).toEqual([
              "Seeding data from seeds/a.sql...\n",
              "Seeding data from seeds/b.sql...\n",
            ]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});

describe("applySeedFiles scanner buffer size", () => {
  it.effect(
    "rejects an oversized seed statement when SUPABASE_SCANNER_BUFFER_SIZE is configured (Go SeedFile.ExecBatchWithCache parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "seed-scanner-"));
      // The seed text must exceed the 4096-byte scanner floor regardless of the configured
      // limit (see migration-apply.unit.test.ts's equivalent case).
      writeFileSync(join(dir, "big.sql"), `insert into t values ('${"x".repeat(5000)}');`);
      const { session, queries } = fakeSession();
      const out = mockOutput();
      const previous = process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
      process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = "100b";
      return run(session, dir, ["big.sql"], out).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            expect(queries.some((q) => q.sql.includes("insert into t"))).toBe(false);
            rmSync(dir, { recursive: true, force: true });
            if (previous === undefined) delete process.env["SUPABASE_SCANNER_BUFFER_SIZE"];
            else process.env["SUPABASE_SCANNER_BUFFER_SIZE"] = previous;
          }),
        ),
      );
    },
  );
});

describe("applySeedFiles stepped-down session", () => {
  it.effect("restores the role right after a reset and before the seed_files upsert", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "seed.sql"), "set role r;\nreset role;\ninsert into t values (1);");
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
    return run(session, dir, ["seed.sql"], out).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const resetAt = calls.indexOf("reset role");
          const upsertAt = calls.findIndex((sql) =>
            sql.includes("INSERT INTO supabase_migrations.seed_files"),
          );
          expect(calls[resetAt + 1]).toBe("SET SESSION ROLE postgres");
          expect(upsertAt).toBeGreaterThan(resetAt);
          expect(out.stderrText).not.toContain("WARN:");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
