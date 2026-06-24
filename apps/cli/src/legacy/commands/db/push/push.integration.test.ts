import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { legacyDbPush } from "./push.handler.ts";
import type { LegacyDbPushFlags } from "./push.command.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";
const READ_VAULT = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const DEFAULT_FLAGS: LegacyDbPushFlags = {
  includeAll: false,
  includeRoles: false,
  includeSeed: false,
  dryRun: false,
  dbUrl: Option.none(),
  linked: false,
  local: true,
  password: Option.none(),
};

function mockResolver(opts: { isLocal?: boolean } = {}) {
  return Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) =>
      Effect.succeed({
        conn: LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
      } satisfies LegacyResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
}

function mockConnection(opts: {
  remoteMigrations?: ReadonlyArray<string>;
  remoteSeeds?: Readonly<Record<string, string>>;
  vaultRows?: ReadonlyArray<{ id: string; name: string }>;
  noSeedTable?: boolean;
  failExec?: string;
}) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, LegacyDbExecError> =>
          Effect.suspend((): Effect.Effect<void, LegacyDbExecError> => {
            execs.push(sql);
            if (opts.failExec !== undefined && sql === opts.failExec) {
              return Effect.fail(
                new LegacyDbExecError({ message: "ERROR: boom (SQLSTATE 42601)" }),
              );
            }
            return Effect.void;
          }),
        query: (
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> =>
          Effect.suspend(
            (): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> => {
              queries.push({ sql, params });
              if (sql === LIST_MIGRATIONS) {
                return Effect.succeed(
                  (opts.remoteMigrations ?? []).map((version) => ({ version })),
                );
              }
              if (sql === SELECT_SEEDS) {
                if (opts.noSeedTable === true) {
                  return Effect.fail(
                    new LegacyDbExecError({
                      message: 'relation "supabase_migrations.seed_files" does not exist',
                      code: "42P01",
                    }),
                  );
                }
                return Effect.succeed(
                  Object.entries(opts.remoteSeeds ?? {}).map(([path, hash]) => ({ path, hash })),
                );
              }
              if (sql === READ_VAULT) {
                return Effect.succeed(opts.vaultRows ?? []);
              }
              return Effect.succeed([]);
            },
          ),
      }),
  });
  return {
    layer,
    get execs() {
      return execs;
    },
    get queries() {
      return queries;
    },
  };
}

function setup(
  workdir: string,
  opts: {
    toml?: string;
    files?: Readonly<Record<string, string>>;
    format?: OutputFormat;
    confirm?: ReadonlyArray<boolean>;
    args?: ReadonlyArray<string>;
    yes?: boolean;
    isLocal?: boolean;
    projectRef?: string;
    linkedFails?: boolean;
    remoteMigrations?: ReadonlyArray<string>;
    remoteSeeds?: Readonly<Record<string, string>>;
    vaultRows?: ReadonlyArray<{ id: string; name: string }>;
    noSeedTable?: boolean;
    failExec?: string;
  },
) {
  if (opts.toml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.toml);
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(workdir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const out = mockOutput({ format: opts.format ?? "text", promptConfirmResponses: opts.confirm });
  const conn = mockConnection(opts);
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();
  const projectRefLayer = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(opts.projectRef ?? LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(opts.projectRef ?? LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.projectRef ?? LEGACY_VALID_REF)),
    loadProjectRef: () =>
      opts.linkedFails === true
        ? Effect.fail(
            new LegacyProjectNotLinkedError({
              message: "Cannot find project ref. Have you run supabase link?",
            }),
          )
        : Effect.succeed(opts.projectRef ?? LEGACY_VALID_REF),
    promptProjectRef: () => Effect.succeed(opts.projectRef ?? LEGACY_VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    conn.layer,
    mockResolver({ isLocal: opts.isLocal ?? true }),
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    Layer.succeed(CliArgs, { args: opts.args ?? ["db", "push", "--local"] }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    projectRefLayer,
    telemetry.layer,
    linkedCache.layer,
  );
  return { layer, out, conn, telemetry, linkedCache };
}

const MIGRATION_DIR = "supabase/migrations";
const migrationFile = (version: string, body = "create table t ();") => ({
  [`${MIGRATION_DIR}/${version}_test.sql`]: body,
});

describe("legacy db push", () => {
  const tmp = useLegacyTempWorkdir("supabase-db-push-");

  it.live("reports up to date when nothing is pending (text)", () => {
    const { layer, out, conn } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("Local database is up to date.\n");
      // No migration was applied.
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.live("emits a json result for an up-to-date run", () => {
    const { layer, out } = setup(tmp.current, { toml: 'project_id = "test"\n', format: "json" });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["upToDate"]).toBe(true);
      expect(success?.data?.["migrations"]).toEqual([]);
    });
  });

  it.live("rejects mutually exclusive target flags", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "push", "--local", "--linked"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("applies a pending migration after confirmation", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      // "supabase db push" is wrapped in Aqua (cyan) on stdout, matching Go.
      expect(out.stdoutText).toContain("Finished");
      expect(out.stdoutText).toContain("supabase db push");
      // The migration body + history insert ran inside a transaction.
      expect(conn.execs).toContain("BEGIN");
      expect(conn.execs).toContain("COMMIT");
      expect(conn.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(
        true,
      );
    });
  });

  it.live("returns context canceled when the migration prompt is declined", () => {
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("context canceled");
      }
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.live("prints the plan without applying in dry-run mode", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, dryRun: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("DRY RUN: migrations will *not* be pushed to the database.");
      expect(out.stderrText).toContain("Would push these migrations:");
      expect(out.stderrText).toContain("20240101000000_test.sql");
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.live("fails with a repair suggestion when remote has versions missing locally", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      remoteMigrations: ["20240101000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "Remote migration versions not found in local migrations directory.",
        );
        expect(JSON.stringify(exit.cause)).toContain("migration repair --status reverted");
      }
      expect(out).toBeDefined();
    });
  });

  it.live("fails with an --include-all suggestion for out-of-order local migrations", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      // 0101 is local-only and ordered before the already-applied remote 0202.
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      remoteMigrations: ["20240202000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("--include-all");
      }
    });
  });

  it.live("pushes out-of-order migrations with --include-all", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      remoteMigrations: ["20240202000000"],
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeAll: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.live("skips migrations when disabled in config and reports up to date", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.migrations]\nenabled = false\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain(
        "Skipping migrations because it is disabled in config.toml for project:",
      );
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    });
  });

  it.live("seeds a new file with --include-seed", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
      expect(
        conn.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
    });
  });

  it.live("reports seed files up to date when hash matches remote", () => {
    // sha256 of the seed body must match the remote hash to be skipped.
    const body = "insert into t values (1);";
    const hash = createHash("sha256").update(body).digest("hex");
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": body },
      remoteSeeds: { "supabase/seed.sql": hash },
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    });
  });

  it.live("skips seeding when disabled in config", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nenabled = false\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain(
        "Skipping seed because it is disabled in config.toml for project:",
      );
    });
  });

  it.live("creates custom roles with --include-roles", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Seeding globals from roles.sql...");
    });
  });

  it.live("reports schema migrations up to date when only roles are pushed", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Schema migrations are up to date.");
    });
  });

  it.live("returns context canceled when the roles prompt is declined", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("context canceled");
    });
  });

  it.live("returns context canceled when the seed prompt is declined", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("context canceled");
    });
  });

  it.live("re-hashes a dirty seed without re-running its statements", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      // Remote hash differs → dirty.
      remoteSeeds: { "supabase/seed.sql": "stalehash" },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Updating seed hash to supabase/seed.sql...");
      // Dirty seed only upserts the hash; the body statement is not executed.
      expect(conn.execs).not.toContain("insert into t values (1);");
    });
  });

  it.live("treats every seed as pending when the seed_files table is absent", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      noSeedTable: true,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
    });
  });

  it.live("warns and reports up to date when no seed files match", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nsql_paths = ["missing.sql"]\n',
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("WARN: no files matched pattern: supabase/missing.sql");
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    });
  });

  it.live("reports seed files up to date when migrations push but no seeds match", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nsql_paths = ["missing.sql"]\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Seed files are up to date.");
    });
  });

  it.live("upserts vault secrets (update existing, create new) before migrating", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nexisting = "v1"\nfresh = "v2"\n',
      files: migrationFile("20240101000000"),
      // `existing` already present remotely → update; `fresh` → create.
      vaultRows: [{ id: "id-1", name: "existing" }],
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Updating vault secrets...");
      const sqls = conn.queries.map((q) => q.sql);
      expect(sqls).toContain("SELECT vault.update_secret($1, $2)");
      expect(sqls).toContain("SELECT vault.create_secret($1, $2)");
    });
  });

  it.live("defaults to the linked target when no target flag is set", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "push"],
      isLocal: false,
      projectRef: LEGACY_VALID_REF,
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, local: false }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Connecting to remote database...");
      expect(out.stdoutText).toBe("Remote database is up to date.\n");
    });
  });

  it.live("surfaces an apply error with statement context", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000", "BOOM;"),
      failExec: "BOOM",
      confirm: [true],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("At statement: 0");
      }
    });
  });

  it.live("dry-run lists roles, migrations and seeds without applying", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/roles.sql": "create role app;",
        "supabase/seed.sql": "insert into t values (1);",
      },
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({
        ...DEFAULT_FLAGS,
        dryRun: true,
        includeRoles: true,
        includeSeed: true,
      }).pipe(Effect.provide(layer));
      // The roles path is wrapped in Bold (ANSI), matching Go's utils.Bold.
      expect(out.stderrText).toContain("Would create custom roles");
      expect(out.stderrText).toContain("roles.sql");
      expect(out.stderrText).toContain("Would push these migrations:");
      expect(out.stderrText).toContain("Would seed these files:");
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.live("dry-run with only custom roles lists them without a migration section", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, dryRun: true, includeRoles: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Would create custom roles");
      expect(out.stderrText).not.toContain("Would push these migrations:");
    });
  });

  it.live("uses embedded defaults when no config file is present", () => {
    const { layer, out } = setup(tmp.current, {
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      // No config.toml written → loadProjectConfig returns null → default config
      // (migrations enabled), and the vault document is absent.
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.live("fails when config.toml cannot be parsed", () => {
    const { layer } = setup(tmp.current, { toml: "this is = = not [[[ valid toml" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to parse supabase/config.toml");
      }
    });
  });

  it.live("announces a matching [remotes.*] override on the linked path", () => {
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${LEGACY_VALID_REF}"\n`,
      args: ["db", "push", "--linked"],
      isLocal: false,
      projectRef: LEGACY_VALID_REF,
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, local: false, linked: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Loading config override: [remotes.preview]");
    });
  });

  it.live("pushes to the linked project and caches the project ref (json)", () => {
    const { layer, out, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      args: ["db", "push", "--linked"],
      isLocal: false,
      projectRef: LEGACY_VALID_REF,
      format: "json",
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, local: false, linked: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Connecting to remote database...");
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(LEGACY_VALID_REF);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["migrations"]).toEqual(["20240101000000_test.sql"]);
    });
  });
});
