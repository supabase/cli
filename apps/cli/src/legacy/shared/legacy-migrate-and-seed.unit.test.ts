import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Formatter, Layer, Path } from "effect";

import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { actionability, ErrorActionabilityId } from "../../shared/telemetry/error-actionability.ts";
import { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { LegacyMigrationApplyError } from "./legacy-migration-apply.ts";
import {
  legacyMigrateAndSeed,
  type LegacyMigrateAndSeedConfig,
} from "./legacy-migrate-and-seed.ts";
import { LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION } from "./legacy-pg-net-guidance.ts";

// Root bypasses POSIX permission bits, so chmod 000 wouldn't block readdir() there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function fakeSession() {
  const execs: Array<string> = [];
  // A file's statements travel as one batch, so both entry points record into
  // `execs` — the assertions below only care about which SQL reached the database.
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        execs.push(sql);
      }),
    execBatch: (statements) =>
      Effect.sync(() => {
        for (const { sql } of statements) execs.push(sql);
      }),
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

/** Every statement fails, whether it runs standalone or inside a batch. */
function failingExecSession(): { session: LegacyDbSession; execs: Array<string> } {
  const execs: Array<string> = [];
  const syntaxError = () => new LegacyDbExecError({ message: "syntax error" });
  const session: LegacyDbSession = {
    exec: (sql) => {
      execs.push(sql);
      return Effect.fail(syntaxError());
    },
    execBatch: (statements) => {
      for (const { sql } of statements) execs.push(sql);
      // The batch dies on its first statement, like a server ErrorResponse before
      // any command completed.
      return Effect.fail(new LegacyDbExecError({ message: "syntax error", statementIndex: 0 }));
    },
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

function pgNetFailureSession(error: LegacyDbExecError): LegacyDbSession {
  const failsOnPgNet = (sql: string): boolean => sql.includes("net.http_post");
  return {
    exec: (sql) => (failsOnPgNet(sql) ? Effect.fail(error) : Effect.void),
    execBatch: (statements) =>
      statements.some(({ sql }) => failsOnPgNet(sql)) ? Effect.fail(error) : Effect.void,
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

const tempRoot = useLegacyTempWorkdir("legacy-migrate-and-seed-");

const writeFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  relativePath: string,
  content: string,
) => {
  const fullPath = path.join(workdir, relativePath);
  return fs
    .makeDirectory(path.dirname(fullPath), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(fullPath, content)));
};

const withFixture = <A>(
  use: (
    workdir: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, Error, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* use(tempRoot.current, fs, path);
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie);

const baseConfig: LegacyMigrateAndSeedConfig = {
  projectEnv: {},
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
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/schemas/a.sql",
            "create table schema_marker ();",
          );
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/migrations/20240101000000_x.sql",
            "create table migration_marker ();",
          );
          yield* run(
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
          );
          expect(execs).toContain("create table schema_marker ()");
          expect(execs).not.toContain("create table migration_marker ()");
          // `applyMigrationFiles` prints "Applying migration ...", which
          // `applySchemaFiles` never does — confirms the migration branch didn't run too.
          expect(out.rawChunks.map((c) => c.text).join("")).not.toContain("Applying migration");
        }),
      );
    },
  );

  it.effect(
    "falls back to migration files when pg-delta is enabled, even with experimental on and an empty version",
    () => {
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/schemas/a.sql",
            "create table schema_marker ();",
          );
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/migrations/20240101000000_x.sql",
            "create table migration_marker ();",
          );
          yield* run(
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
          );
          expect(execs).toContain("create table migration_marker ()");
          expect(execs).not.toContain("create table schema_marker ()");
        }),
      );
    },
  );

  it.effect("falls back to migration files when experimental is off", () => {
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* writeFile(
          fs,
          path,
          workdir,
          "supabase/schemas/a.sql",
          "create table schema_marker ();",
        );
        yield* writeFile(
          fs,
          path,
          workdir,
          "supabase/migrations/20240101000000_x.sql",
          "create table migration_marker ();",
        );
        yield* run(
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
        );
        expect(execs).toContain("create table migration_marker ()");
        expect(execs).not.toContain("create table schema_marker ()");
      }),
    );
  });

  it.effect(
    "falls back to migration files when a concrete version is passed, even with experimental on",
    () => {
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/schemas/a.sql",
            "create table schema_marker ();",
          );
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/migrations/20240101000000_x.sql",
            "create table migration_marker ();",
          );
          yield* run(
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
          );
          expect(execs).toContain("create table migration_marker ()");
          expect(execs).not.toContain("create table schema_marker ()");
        }),
      );
    },
  );

  it.effect("still seeds after the declarative-schema branch runs", () => {
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* writeFile(
          fs,
          path,
          workdir,
          "supabase/schemas/a.sql",
          "create table schema_marker ();",
        );
        yield* writeFile(
          fs,
          path,
          workdir,
          "supabase/seed.sql",
          "insert into schema_marker default values;",
        );
        yield* run(
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
        );
        expect(execs).toContain("create table schema_marker ()");
        expect(execs).toContain("insert into schema_marker default values");
      }),
    );
  });

  // Same two scenarios as the original test suite this was ported from.
  it.effect(
    "expands a directory schema_paths entry to its .sql files, recursively, in declared order",
    () => {
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, workdir, "supabase/schemas/z_function.sql", "select 1;");
          yield* writeFile(fs, path, workdir, "supabase/schemas/tables/a_table.sql", "select 2;");
          yield* writeFile(
            fs,
            path,
            workdir,
            "supabase/schemas/tables/nested/b_table.sql",
            "select 3;",
          );
          yield* writeFile(fs, path, workdir, "supabase/schemas/tables/readme.md", "ignored");
          yield* run(
            workdir,
            "",
            {
              ...baseConfig,
              experimental: true,
              schemaPaths: ["supabase/schemas/z_function.sql", "supabase/schemas/tables"],
            },
            session,
            out,
          );
          const order = execs.filter((sql) => sql.startsWith("select "));
          expect(order).toEqual(["select 1", "select 2", "select 3"]);
        }),
      );
    },
  );

  it.effect("deduplicates an explicit file also matched by a directory/glob pattern", () => {
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* writeFile(fs, path, workdir, "supabase/database/a.sql", "select 10;");
        yield* writeFile(fs, path, workdir, "supabase/database/b.sql", "select 20;");
        yield* run(
          workdir,
          "",
          {
            ...baseConfig,
            experimental: true,
            schemaPaths: [
              "supabase/database/a.sql",
              "supabase/database",
              "supabase/database/*.sql",
            ],
          },
          session,
          out,
        );
        const order = execs.filter((sql) => sql.startsWith("select "));
        // Each file applied exactly once, in sorted order — not once per matching pattern.
        expect(order).toEqual(["select 10", "select 20"]);
      }),
    );
  });

  it.effect.skipIf(isRoot)(
    "fails a matched schema_paths directory that cannot be traversed, instead of treating it as empty",
    () => {
      // `walkMatchedDir` returns `failed to walk matched directory: %w` on a read
      // error; `applySchemaFiles` propagates it when nothing else matched either. Mode
      // 000 makes `stat` (parent-directory lookup) succeed but `readdir` fail with EACCES.
      const { session } = fakeSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.gen(function* () {
          const lockedDir = path.join(workdir, "supabase", "schemas", "locked");
          yield* fs.makeDirectory(lockedDir, { recursive: true });
          yield* writeFile(fs, path, workdir, "supabase/schemas/locked/b.sql", "select 1;");
          yield* fs.chmod(lockedDir, 0o000);
          const exit = yield* run(
            workdir,
            "",
            {
              ...baseConfig,
              experimental: true,
              schemaPaths: ["supabase/schemas/locked"],
            },
            session,
            out,
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Formatter.formatJson(exit.cause)).toContain("failed to walk matched directory");
          }
          yield* fs.chmod(lockedDir, 0o755);
        }),
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
      const { session, execs } = fakeSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.acquireUseRelease(
          fs.makeTempDirectory({ prefix: "legacy-migrate-and-seed-outside-" }),
          (outsideDir) =>
            Effect.gen(function* () {
              yield* writeFile(fs, path, outsideDir, "escaped.sql", "select 999;");
              yield* writeFile(fs, path, outsideDir, "linked-target.sql", "select 888;");
              yield* writeFile(fs, path, workdir, "supabase/schemas/real.sql", "select 1;");
              yield* fs.symlink(
                path.join(outsideDir, "linked-target.sql"),
                path.join(workdir, "supabase", "schemas", "link-to-file.sql"),
              );
              yield* fs.symlink(
                outsideDir,
                path.join(workdir, "supabase", "schemas", "link-to-dir"),
              );
              yield* run(
                workdir,
                "",
                {
                  ...baseConfig,
                  experimental: true,
                  schemaPaths: ["supabase/schemas"],
                },
                session,
                out,
              );
              expect(execs).toContain("select 1");
              expect(execs).not.toContain("select 888");
              expect(execs).not.toContain("select 999");
            }),
          (outsideDir) => fs.remove(outsideDir, { recursive: true, force: true }),
        ),
      );
    },
  );

  it.effect(
    "attaches the failing schema file as Go's CmdSuggestion (See schema file: <fp>)",
    () => {
      const schemaPath = "supabase/schemas/broken.sql";
      const { session } = failingExecSession();
      const out = mockOutput();
      return withFixture((workdir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, workdir, schemaPath, "totally not valid sql;");
          const error = yield* run(
            workdir,
            "",
            {
              ...baseConfig,
              experimental: true,
              schemaPaths: [schemaPath],
            },
            session,
            out,
          ).pipe(Effect.flip, Effect.orDie);
          expect(error).toBeInstanceOf(LegacyMigrationApplyError);
          assertMigrationApplyError(error);
          const suggestion = error.suggestion;
          expect(suggestion).toBeDefined();
          expect(stripAnsi(suggestion ?? "")).toBe(`See schema file: ${schemaPath}`);
        }),
      );
    },
  );
});

describe("legacyMigrateAndSeed local pg_net remediation", () => {
  const missingNetSchema = new LegacyDbExecError({
    message: 'ERROR: schema "net" does not exist (SQLSTATE 3F000)',
    code: "3F000",
  });

  const setupMigration = (fs: FileSystem.FileSystem, path: Path.Path, workdir: string) =>
    writeFile(
      fs,
      path,
      workdir,
      "supabase/migrations/20240101000000_webhook.sql",
      "select net.http_post(url := 'https://example.com');",
    );

  it.effect("suggests enabling Database Webhooks when local replay cannot find pg_net", () => {
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* setupMigration(fs, path, workdir);
        const error = yield* run(
          workdir,
          "",
          { ...baseConfig, localDatabaseWebhooksEnabled: false },
          pgNetFailureSession(missingNetSchema),
          out,
        ).pipe(Effect.flip, Effect.orDie);
        assertMigrationApplyError(error);
        expect(error.suggestion).toBe(LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION);
        expect(error[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      }),
    );
  });

  it.effect("does not add the local hint when webhooks are enabled", () => {
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* setupMigration(fs, path, workdir);
        const error = yield* run(
          workdir,
          "",
          { ...baseConfig, localDatabaseWebhooksEnabled: true },
          pgNetFailureSession(missingNetSchema),
          out,
        ).pipe(Effect.flip, Effect.orDie);
        assertMigrationApplyError(error);
        expect(error.suggestion).toBeUndefined();
        expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
      }),
    );
  });

  it.effect("does not add the local hint for migration commands without local context", () => {
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* setupMigration(fs, path, workdir);
        const error = yield* run(
          workdir,
          "",
          baseConfig,
          pgNetFailureSession(missingNetSchema),
          out,
        ).pipe(Effect.flip, Effect.orDie);
        assertMigrationApplyError(error);
        expect(error.suggestion).toBeUndefined();
        expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
      }),
    );
  });
});

describe("legacyMigrateAndSeed apply order", () => {
  it.effect("applies mixed-width versions in version order, like db push (#6036)", () => {
    // `20260420010000_b.sql` precedes `20260420_a.sql` in file-name order
    // ('0' < '_'), the reverse of the version order `db push` applies in since
    // #6038. Unsorted, `db reset`/`db start` replay `b` before `a` locally while
    // `db push` sends `a` before `b` remotely.
    const { session, execs } = fakeSession();
    const out = mockOutput();
    return withFixture((workdir, fs, path) =>
      Effect.gen(function* () {
        yield* writeFile(
          fs,
          path,
          workdir,
          "supabase/migrations/20260420_a.sql",
          "create table t (id int);",
        );
        yield* writeFile(
          fs,
          path,
          workdir,
          "supabase/migrations/20260420010000_b.sql",
          "alter table t add c int;",
        );
        yield* run(workdir, "", baseConfig, session, out);
        expect(execs.filter((sql) => sql.includes("table t"))).toEqual([
          "create table t (id int)",
          "alter table t add c int",
        ]);
      }),
    );
  });
});
