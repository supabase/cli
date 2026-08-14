import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { actionability, ErrorActionabilityId } from "../../shared/telemetry/error-actionability.ts";
import { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { LegacyMigrationApplyError } from "./legacy-migration-apply.ts";
import {
  legacyMigrateAndSeed,
  type LegacyMigrateAndSeedConfig,
} from "./legacy-migrate-and-seed.ts";
import {
  LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION,
  legacyIsPgNetUnavailableError,
} from "./legacy-pg-net-guidance.ts";

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

/** Every statement fails except the `BEGIN`/`COMMIT`/`ROLLBACK` transaction control Go wraps it in. */
function failingExecSession(): { session: LegacyDbSession; execs: Array<string> } {
  const execs: Array<string> = [];
  const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);
  const session: LegacyDbSession = {
    exec: (sql) => {
      execs.push(sql);
      return TRANSACTION_CONTROL.has(sql)
        ? Effect.sync(() => {})
        : Effect.fail(new LegacyDbExecError({ message: "syntax error" }));
    },
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

function pgNetFailureSession(error: LegacyDbExecError): LegacyDbSession {
  return {
    exec: (sql) => (sql.includes("net.http_post") ? Effect.fail(error) : Effect.void),
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
}

function assertMigrationApplyError(error: unknown): asserts error is LegacyMigrationApplyError {
  expect(error).toBeInstanceOf(LegacyMigrationApplyError);
  if (!(error instanceof LegacyMigrationApplyError)) {
    throw new Error("expected LegacyMigrationApplyError");
  }
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
            // `applyMigrationFiles` prints "Applying migration ...", which
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

  // Same two scenarios as the original test suite this was ported from.
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
      // `walkMatchedDir` returns `failed to walk matched directory: %w` on a read
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

  it.effect(
    "skips a symlinked .sql file and an entire symlinked subdirectory inside a matched schema_paths directory",
    () => {
      // `walkMatchedDir` (`fs.WalkDir` + `entry.Type().IsRegular()`) never follows a
      // symlinked `DirEntry` — a symlinked `.sql` file is excluded regardless of target, and a
      // symlinked subdirectory is never even descended into. Both live OUTSIDE the matched
      // directory here, so applying either would mean executing SQL Go would never touch.
      const workdir = makeWorkdir();
      const outsideDir = mkdtempSync(join(tmpdir(), "legacy-migrate-and-seed-outside-"));
      writeFileSync(join(outsideDir, "escaped.sql"), "select 999;");
      writeFileSync(join(outsideDir, "linked-target.sql"), "select 888;");
      writeFile(workdir, "supabase/schemas/real.sql", "select 1;");
      symlinkSync(
        join(outsideDir, "linked-target.sql"),
        join(workdir, "supabase", "schemas", "link-to-file.sql"),
      );
      symlinkSync(outsideDir, join(workdir, "supabase", "schemas", "link-to-dir"));
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          schemaPaths: ["supabase/schemas"],
        },
        session,
        out,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(execs).toContain("select 1");
            expect(execs).not.toContain("select 888");
            expect(execs).not.toContain("select 999");
            rmSync(workdir, { recursive: true, force: true });
            rmSync(outsideDir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "attaches the failing schema file as Go's CmdSuggestion (See schema file: <fp>)",
    () => {
      const workdir = makeWorkdir();
      const schemaPath = "supabase/schemas/broken.sql";
      writeFile(workdir, schemaPath, "totally not valid sql;");
      const { session } = failingExecSession();
      const out = mockOutput();
      return run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          schemaPaths: [schemaPath],
        },
        session,
        out,
      ).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(LegacyMigrationApplyError);
            const suggestion = (error as LegacyMigrationApplyError).suggestion;
            expect(suggestion).toBeDefined();
            expect(stripAnsi(suggestion ?? "")).toBe(`See schema file: ${schemaPath}`);
            rmSync(workdir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});

describe("legacyMigrateAndSeed local pg_net remediation", () => {
  const missingNetSchema = new LegacyDbExecError({
    message: 'ERROR: schema "net" does not exist (SQLSTATE 3F000)',
    code: "3F000",
  });

  const setupMigration = (workdir: string) =>
    writeFile(
      workdir,
      "supabase/migrations/20240101000000_webhook.sql",
      "select net.http_post(url := 'https://example.com');",
    );

  it("classifies only pg_net schema/function errors with their matching SQLSTATE", () => {
    expect(legacyIsPgNetUnavailableError(missingNetSchema)).toBe(true);
    expect(
      legacyIsPgNetUnavailableError({
        message: "ERROR: function net.http_post(unknown, jsonb) does not exist (SQLSTATE 42883)",
        code: "42883",
      }),
    ).toBe(true);
    expect(
      legacyIsPgNetUnavailableError({
        message: "ERROR: function public.http_post(unknown) does not exist (SQLSTATE 42883)",
        code: "42883",
      }),
    ).toBe(false);
  });

  it.effect("suggests enabling Database Webhooks when local replay cannot find pg_net", () => {
    const workdir = makeWorkdir();
    setupMigration(workdir);
    const out = mockOutput();
    return run(
      workdir,
      "",
      { ...baseConfig, localDatabaseWebhooksEnabled: false },
      pgNetFailureSession(missingNetSchema),
      out,
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          assertMigrationApplyError(error);
          expect(error.suggestion).toBe(LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION);
          expect(error[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not add the local hint when webhooks are enabled", () => {
    const workdir = makeWorkdir();
    setupMigration(workdir);
    const out = mockOutput();
    return run(
      workdir,
      "",
      { ...baseConfig, localDatabaseWebhooksEnabled: true },
      pgNetFailureSession(missingNetSchema),
      out,
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          assertMigrationApplyError(error);
          expect(error.suggestion).toBeUndefined();
          expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not add the local hint for migration commands without local context", () => {
    const workdir = makeWorkdir();
    setupMigration(workdir);
    const out = mockOutput();
    return run(workdir, "", baseConfig, pgNetFailureSession(missingNetSchema), out).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          assertMigrationApplyError(error);
          expect(error.suggestion).toBeUndefined();
          expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("requires the matching SQLSTATE instead of classifying by message alone", () => {
    const workdir = makeWorkdir();
    setupMigration(workdir);
    const out = mockOutput();
    const wrongSqlState = new LegacyDbExecError({
      message: 'ERROR: schema "net" does not exist (SQLSTATE 42P01)',
      code: "42P01",
    });
    return run(
      workdir,
      "",
      { ...baseConfig, localDatabaseWebhooksEnabled: false },
      pgNetFailureSession(wrongSqlState),
      out,
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          assertMigrationApplyError(error);
          expect(error.suggestion).toBeUndefined();
          expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
          rmSync(workdir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
