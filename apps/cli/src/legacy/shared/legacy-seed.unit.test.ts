import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyApplySeedFiles } from "./legacy-seed.ts";

function fakeSession() {
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: LegacyDbSession = {
    exec: () => Effect.void,
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
  session: LegacyDbSession,
  workdir: string,
  sqlPaths: ReadonlyArray<string>,
  out: ReturnType<typeof mockOutput>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyApplySeedFiles(session, fs, path, workdir, { enabled: true, sqlPaths });
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)));

describe("legacyApplySeedFiles seed glob", () => {
  it.effect("treats a backslash escape as a glob metacharacter (matches the real file)", () => {
    // Go's `io/fs.hasMeta` counts `\` (escape), so `seed\.sql` globs via path.Match
    // and matches the literal `seed.sql` — not a file named `seed\.sql`.
    const dir = mkdtempSync(join(tmpdir(), "legacy-seed-"));
    writeFileSync(join(dir, "seed.sql"), "insert into t values (1);");
    const { session, queries } = fakeSession();
    const out = mockOutput();
    return run(session, dir, ["seed\\.sql"], out).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // The seed file was found and recorded under its clean path.
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
    // `missing\.sql` escapes to the literal `missing.sql`; with no such file it matches
    // nothing and Go emits a single `no files matched pattern` warning.
    const dir = mkdtempSync(join(tmpdir(), "legacy-seed-"));
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
});
