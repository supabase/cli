import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { stripAnsi } from "../../tests/helpers/ansi.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { actionability, ErrorActionabilityId } from "../shared/telemetry/error-actionability.ts";
import { DbExecError } from "./db-connection.errors.ts";
import type { DbSession } from "./db-connection.service.ts";
import { MigrationApplyError } from "./migration-apply.ts";
import { migrateAndSeed, type MigrateAndSeedConfig } from "./migrate-and-seed.ts";
import { ENABLE_LOCAL_WEBHOOKS_SUGGESTION } from "./pg-net-guidance.ts";

// Root bypasses POSIX permission bits, so chmod 000 wouldn't block readdir() there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function fakeSession() {
  const execs: Array<string> = [];
  // A file's statements travel as one batch, so both entry points record into
  // `execs` — the assertions below only care about which SQL reached the database.
  const session: DbSession = {
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
function failingExecSession(): { session: DbSession; execs: Array<string> } {
  const execs: Array<string> = [];
  const syntaxError = () => new DbExecError({ message: "syntax error" });
  const session: DbSession = {
    exec: (sql) => {
      execs.push(sql);
      return Effect.fail(syntaxError());
    },
    execBatch: (statements) => {
      for (const { sql } of statements) execs.push(sql);
      // The batch dies on its first statement, like a server ErrorResponse before
      // any command completed.
      return Effect.fail(new DbExecError({ message: "syntax error", statementIndex: 0 }));
    },
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

function pgNetFailureSession(error: DbExecError): DbSession {
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

function assertMigrationApplyError(error: unknown): asserts error is MigrationApplyError {
  expect(error).toBeInstanceOf(MigrationApplyError);
  if (!(error instanceof MigrationApplyError)) {
    throw new Error("expected MigrationApplyError");
  }
}

const makeWorkdir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "migrate-and-seed-" });
});

const writeFile = Effect.fnUntraced(function* (
  workdir: string,
  relativePath: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fullPath = path.join(workdir, relativePath);
  yield* fs.makeDirectory(path.dirname(fullPath), { recursive: true });
  yield* fs.writeFileString(fullPath, content);
});

const baseConfig: MigrateAndSeedConfig = {
  migrationsEnabled: true,
  seed: { enabled: false, sqlPaths: [] },
  experimental: false,
  pgDeltaEnabled: false,
  schemaPaths: [],
};

const run = (
  workdir: string,
  version: string,
  config: MigrateAndSeedConfig,
  session: DbSession,
  out: ReturnType<typeof mockOutput>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* migrateAndSeed(session, fs, path, workdir, version, config);
  }).pipe(Effect.provide(out.layer));

layer(NodeServices.layer)("migrateAndSeed experimental declarative-schema branch", (it) => {
  it.effect(
    "applies schema_paths files instead of migrations when experimental is on, pg-delta is off, and version is empty",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir;
        yield* writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
        yield* writeFile(
          workdir,
          "supabase/migrations/20240101000000_x.sql",
          "create table migration_marker ();",
        );
        const { session, execs } = fakeSession();
        const out = mockOutput();
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
        expect(out.rawChunks.map((c) => c.text).join("")).not.toContain("Applying migration");
      }),
  );

  it.effect(
    "falls back to migration files when pg-delta is enabled, even with experimental on and an empty version",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir;
        yield* writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
        yield* writeFile(
          workdir,
          "supabase/migrations/20240101000000_x.sql",
          "create table migration_marker ();",
        );
        const { session, execs } = fakeSession();
        const out = mockOutput();
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

  it.effect("falls back to migration files when experimental is off", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
      yield* writeFile(
        workdir,
        "supabase/migrations/20240101000000_x.sql",
        "create table migration_marker ();",
      );
      const { session, execs } = fakeSession();
      const out = mockOutput();
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

  it.effect(
    "falls back to migration files when a concrete version is passed, even with experimental on",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir;
        yield* writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
        yield* writeFile(
          workdir,
          "supabase/migrations/20240101000000_x.sql",
          "create table migration_marker ();",
        );
        const { session, execs } = fakeSession();
        const out = mockOutput();
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

  it.effect("still seeds after the declarative-schema branch runs", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* writeFile(workdir, "supabase/schemas/a.sql", "create table schema_marker ();");
      yield* writeFile(workdir, "supabase/seed.sql", "insert into schema_marker default values;");
      const { session, execs } = fakeSession();
      const out = mockOutput();
      yield* run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          pgDeltaEnabled: false,
          schemaPaths: ["supabase/schemas/a.sql"],
          // schemaPaths/sqlPaths arrive already `supabase/`-prefixed from their real caller.
          seed: { enabled: true, sqlPaths: ["supabase/seed.sql"] },
        },
        session,
        out,
      );
      expect(execs).toContain("create table schema_marker ()");
      expect(execs).toContain("insert into schema_marker default values");
    }),
  );

  it.effect(
    "expands a directory schema_paths entry to its .sql files, recursively, in declared order",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir;
        yield* writeFile(workdir, "supabase/schemas/z_function.sql", "select 1;");
        yield* writeFile(workdir, "supabase/schemas/tables/a_table.sql", "select 2;");
        yield* writeFile(workdir, "supabase/schemas/tables/nested/b_table.sql", "select 3;");
        yield* writeFile(workdir, "supabase/schemas/tables/readme.md", "ignored");
        const { session, execs } = fakeSession();
        const out = mockOutput();
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

  it.effect("deduplicates an explicit file also matched by a directory/glob pattern", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* writeFile(workdir, "supabase/database/a.sql", "select 10;");
      yield* writeFile(workdir, "supabase/database/b.sql", "select 20;");
      const { session, execs } = fakeSession();
      const out = mockOutput();
      yield* run(
        workdir,
        "",
        {
          ...baseConfig,
          experimental: true,
          schemaPaths: ["supabase/database/a.sql", "supabase/database", "supabase/database/*.sql"],
        },
        session,
        out,
      );
      const order = execs.filter((sql) => sql.startsWith("select "));
      // Each file applied exactly once, in sorted order — not once per matching pattern.
      expect(order).toEqual(["select 10", "select 20"]);
    }),
  );

  it.effect.skipIf(isRoot)(
    "fails a matched schema_paths directory that cannot be traversed, instead of treating it as empty",
    () =>
      Effect.gen(function* () {
        // Mode 000 makes `stat` (parent-directory lookup) succeed but `readdir` fail with EACCES,
        // which `applySchemaFiles` propagates as "failed to walk matched directory".
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const lockedDir = path.join(workdir, "supabase", "schemas", "locked");
        yield* writeFile(workdir, "supabase/schemas/locked/b.sql", "select 1;");
        yield* Effect.acquireRelease(fs.chmod(lockedDir, 0o000), () =>
          fs.chmod(lockedDir, 0o755).pipe(Effect.orDie),
        );
        const { session } = fakeSession();
        const out = mockOutput();
        const error = yield* run(
          workdir,
          "",
          {
            ...baseConfig,
            experimental: true,
            schemaPaths: ["supabase/schemas/locked"],
          },
          session,
          out,
        ).pipe(Effect.flip);
        expect(error.message).toContain("failed to walk matched directory");
      }),
  );

  it.effect(
    "skips a symlinked .sql file and an entire symlinked subdirectory inside a matched schema_paths directory",
    () =>
      Effect.gen(function* () {
        // Symlinked files and directories are never followed, regardless of target; both live
        // outside the matched directory here, so applying either would mean executing SQL that
        // should never run.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const outsideDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-and-seed-outside-",
        });
        yield* fs.writeFileString(path.join(outsideDir, "escaped.sql"), "select 999;");
        yield* fs.writeFileString(path.join(outsideDir, "linked-target.sql"), "select 888;");
        yield* writeFile(workdir, "supabase/schemas/real.sql", "select 1;");
        yield* fs.symlink(
          path.join(outsideDir, "linked-target.sql"),
          path.join(workdir, "supabase", "schemas", "link-to-file.sql"),
        );
        yield* fs.symlink(outsideDir, path.join(workdir, "supabase", "schemas", "link-to-dir"));
        const { session, execs } = fakeSession();
        const out = mockOutput();
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
  );

  it.effect("attaches the failing schema file as Go's CmdSuggestion (See schema file: <fp>)", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      const schemaPath = "supabase/schemas/broken.sql";
      yield* writeFile(workdir, schemaPath, "totally not valid sql;");
      const { session } = failingExecSession();
      const out = mockOutput();
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
      ).pipe(Effect.flip);
      assertMigrationApplyError(error);
      expect(error.suggestion).toBeDefined();
      expect(stripAnsi(error.suggestion ?? "")).toBe(`See schema file: ${schemaPath}`);
    }),
  );
});

layer(NodeServices.layer)("migrateAndSeed local pg_net remediation", (it) => {
  const missingNetSchema = new DbExecError({
    message: 'ERROR: schema "net" does not exist (SQLSTATE 3F000)',
    code: "3F000",
  });

  const setupMigration = (workdir: string) =>
    writeFile(
      workdir,
      "supabase/migrations/20240101000000_webhook.sql",
      "select net.http_post(url := 'https://example.com');",
    );

  it.effect("suggests enabling Database Webhooks when local replay cannot find pg_net", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* setupMigration(workdir);
      const out = mockOutput();
      const error = yield* run(
        workdir,
        "",
        { ...baseConfig, localDatabaseWebhooksEnabled: false },
        pgNetFailureSession(missingNetSchema),
        out,
      ).pipe(Effect.flip);
      assertMigrationApplyError(error);
      expect(error.suggestion).toBe(ENABLE_LOCAL_WEBHOOKS_SUGGESTION);
      expect(error[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
    }),
  );

  it.effect("does not add the local hint when webhooks are enabled", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* setupMigration(workdir);
      const out = mockOutput();
      const error = yield* run(
        workdir,
        "",
        { ...baseConfig, localDatabaseWebhooksEnabled: true },
        pgNetFailureSession(missingNetSchema),
        out,
      ).pipe(Effect.flip);
      assertMigrationApplyError(error);
      expect(error.suggestion).toBeUndefined();
      expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
    }),
  );

  it.effect("does not add the local hint for migration commands without local context", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* setupMigration(workdir);
      const out = mockOutput();
      const error = yield* run(
        workdir,
        "",
        baseConfig,
        pgNetFailureSession(missingNetSchema),
        out,
      ).pipe(Effect.flip);
      assertMigrationApplyError(error);
      expect(error.suggestion).toBeUndefined();
      expect(error[ErrorActionabilityId]).toEqual(actionability.dbFinding);
    }),
  );
});

layer(NodeServices.layer)("migrateAndSeed apply order", (it) => {
  it.effect("applies mixed-width versions in version order, like db push (#6036)", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      // File-name order would sort `20260420010000_b.sql` before `20260420_a.sql` ('0' < '_'),
      // the reverse of version order — this asserts the migrations replay in version order.
      yield* writeFile(workdir, "supabase/migrations/20260420_a.sql", "create table t (id int);");
      yield* writeFile(
        workdir,
        "supabase/migrations/20260420010000_b.sql",
        "alter table t add c int;",
      );
      const { session, execs } = fakeSession();
      const out = mockOutput();
      yield* run(workdir, "", baseConfig, session, out);
      expect(execs.filter((sql) => sql.includes("table t"))).toEqual([
        "create table t (id int)",
        "alter table t add c int",
      ]);
    }),
  );
});
