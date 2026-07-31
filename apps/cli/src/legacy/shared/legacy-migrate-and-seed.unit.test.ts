import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  legacyMigrateAndSeed,
  type LegacyMigrateAndSeedConfig,
} from "./legacy-migrate-and-seed.ts";

// Root bypasses POSIX permission bits, so chmod 000 wouldn't block readdir() there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function fakeSession() {
  const execs: Array<string> = [];
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        execs.push(sql);
      }),
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "legacy-migrate-and-seed-"));
}

function writeFile(workdir: string, relativePath: string, content: string): void {
  const fullPath = join(workdir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

const baseConfig: LegacyMigrateAndSeedConfig = {
  migrationsEnabled: true,
  seed: { enabled: false, sqlPaths: [] },
  experimental: false,
  pgDeltaEnabled: false,
  schemaPaths: [],
};

const run = (
  workdir: string,
  version: string,
  config: LegacyMigrateAndSeedConfig,
  session: LegacyDbSession,
  out: ReturnType<typeof mockOutput>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyMigrateAndSeed(session, fs, path, workdir, version, config);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)));

describe("legacyMigrateAndSeed experimental declarative-schema branch", () => {
  it.effect(
    "applies schema_paths files instead of migrations when experimental is on, pg-delta is off, and version is empty",
    () => {
      const workdir = makeWorkdir();
      writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
      writeFile(
        workdir,
        "supabase/migrations/20240101000000_x.sql",
        "create table migration_marker ();",
      );
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          pgDeltaEnabled: false,
          schemaPaths: ["supabase/schemas/a.sql"],
        },
        session,
        out,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(execs).toContain("create table schema_marker ()");
            expect(execs).not.toContain("create table migration_marker ()");
            // Go's `applyMigrationFiles` prints "Applying migration ...", which
            // `applySchemaFiles` never does — confirms the migration branch didn't run too.
            expect(out.rawChunks.map((c) => c.text).join("")).not.toContain("Applying migration");
            rmSync(workdir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "falls back to migration files when pg-delta is enabled, even with experimental on and an empty version",
    () => {
      const workdir = makeWorkdir();
      writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
      writeFile(
        workdir,
        "supabase/migrations/20240101000000_x.sql",
        "create table migration_marker ();",
      );
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          pgDeltaEnabled: true,
          schemaPaths: ["supabase/schemas/a.sql"],
        },
        session,
        out,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(execs).toContain("create table migration_marker ()");
            expect(execs).not.toContain("create table schema_marker ()");
            rmSync(workdir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("falls back to migration files when experimental is off", () => {
    const workdir = makeWorkdir();
    writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
    writeFile(
      workdir,
      "supabase/migrations/20240101000000_x.sql",
      "create table migration_marker ();",
    );
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return run(
      workdir,
      "",
      {
        ...baseConfig,
        experimental: false,
        pgDeltaEnabled: false,
        schemaPaths: ["supabase/schemas/a.sql"],
      },
      session,
      out,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(execs).toContain("create table migration_marker ()");
          expect(execs).not.toContain("create table schema_marker ()");
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "falls back to migration files when a concrete version is passed, even with experimental on",
    () => {
      const workdir = makeWorkdir();
      writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
      writeFile(
        workdir,
        "supabase/migrations/20240101000000_x.sql",
        "create table migration_marker ();",
      );
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return run(
        workdir,
        "20240101000000",
        {
          ...baseConfig,
          experimental: true,
          pgDeltaEnabled: false,
          schemaPaths: ["supabase/schemas/a.sql"],
        },
        session,
        out,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(execs).toContain("create table migration_marker ()");
            expect(execs).not.toContain("create table schema_marker ()");
            rmSync(workdir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("still seeds after the declarative-schema branch runs", () => {
    const workdir = makeWorkdir();
    writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
    writeFile(workdir, "supabase/seed.sql", "insert into schema_marker default values;");
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return run(
      workdir,
      "",
      {
        ...baseConfig,
        experimental: true,
        pgDeltaEnabled: false,
        schemaPaths: ["supabase/schemas/a.sql"],
        // Both `schemaPaths` and `LegacySeedConfig.sqlPaths` arrive already
        // `supabase/`-prefixed by their real caller (`legacy-db-config.toml-read.ts`) — see
        // its own doc comment. Neither field does its own path-shape work anymore.
        seed: { enabled: true, sqlPaths: ["supabase/seed.sql"] },
      },
      session,
      out,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(execs).toContain("create table schema_marker ()");
          expect(execs).toContain("insert into schema_marker default values");
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });

  // Go's `TestGlobSQLFiles` (`pkg/config/config_test.go`) — same two scenarios, ported.
  it.effect(
    "expands a directory schema_paths entry to its .sql files, recursively, in declared order",
    () => {
      const workdir = makeWorkdir();
      writeFile(workdir, "supabase/schemas/z_function.sql", "select 1;");
      writeFile(workdir, "supabase/schemas/tables/a_table.sql", "select 2;");
      writeFile(workdir, "supabase/schemas/tables/nested/b_table.sql", "select 3;");
      writeFile(workdir, "supabase/schemas/tables/readme.md", "ignored");
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          schemaPaths: ["supabase/schemas/z_function.sql", "supabase/schemas/tables"],
        },
        session,
        out,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const order = execs.filter((sql) => sql.startsWith("select "));
            expect(order).toEqual(["select 1", "select 2", "select 3"]);
            rmSync(workdir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("deduplicates an explicit file also matched by a directory/glob pattern", () => {
    const workdir = makeWorkdir();
    writeFile(workdir, "supabase/database/a.sql", "select 10;");
    writeFile(workdir, "supabase/database/b.sql", "select 20;");
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return run(
      workdir,
      "",
      {
        ...baseConfig,
        experimental: true,
        schemaPaths: ["supabase/database/a.sql", "supabase/database", "supabase/database/*.sql"],
      },
      session,
      out,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const order = execs.filter((sql) => sql.startsWith("select "));
          // Each file applied exactly once, in sorted order — not once per matching pattern.
          expect(order).toEqual(["select 10", "select 20"]);
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect.skipIf(isRoot)(
    "fails a matched schema_paths directory that cannot be traversed, instead of treating it as empty",
    () => {
      // Go's `walkMatchedDir` returns `failed to walk matched directory: %w` on a read
      // error; `applySchemaFiles` propagates it when nothing else matched either. Mode
      // 000 makes `stat` (parent-directory lookup) succeed but `readdir` fail with EACCES.
      const workdir = makeWorkdir();
      const lockedDir = join(workdir, "supabase", "schemas", "locked");
      mkdirSync(lockedDir, { recursive: true });
      writeFileSync(join(lockedDir, "b.sql"), "select 1;");
      chmodSync(lockedDir, 0o000);
      const { session } = fakeSession();
      const out = mockOutput();
      return run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          schemaPaths: ["supabase/schemas/locked"],
        },
        session,
        out,
      ).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain("failed to walk matched directory");
            }
            chmodSync(lockedDir, 0o755);
            rmSync(workdir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
