import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
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
    // Prompts (migration/seed confirmation) are answered through mockOutput's
    // `promptConfirmResponses` (the TTY/clack path), so mark stdin a TTY. Stdin is
    // only referenced by legacyPromptYesNo's non-TTY branch (unreached here).
    mockTty({ stdinIsTty: true }),
    mockStdin(true),
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

  it.live("expands a directory in [db.seed].sql_paths to its sorted .sql children", () => {
    // Go's `GetPendingSeeds` (`Glob.SQLFiles`) walks a matched directory and seeds its
    // regular `.sql` files recursively; non-.sql files are skipped. Without dir expansion
    // the directory path reached `readFileString(<dir>)` and failed.
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nsql_paths = ["seeds"]\n',
      files: {
        "supabase/seeds/a.sql": "insert into t values (1);",
        "supabase/seeds/nested/b.sql": "insert into t values (2);",
        "supabase/seeds/notes.txt": "not a seed",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Seeding data from supabase/seeds/a.sql...");
      expect(out.stderrText).toContain("Seeding data from supabase/seeds/nested/b.sql...");
      expect(out.stderrText).not.toContain("notes.txt");
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

  it.live("hashes a non-UTF-8 seed file by its raw bytes (Go's io.Copy parity)", () => {
    // Go's `NewSeedFile` hashes the raw stream; a UTF-8 string decode would replace the
    // invalid bytes and change the hash. Write invalid UTF-8 and pre-seed the remote with
    // the RAW-byte sha256 — the push must treat it as already-applied (byte hash matches),
    // not re-run it. A string-decoded hash here would differ and mark the seed dirty.
    const raw = Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0xfe, 0x00, 0x01, 0x0a]);
    const rawHash = createHash("sha256").update(raw).digest("hex");
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      remoteSeeds: { "supabase/seed.sql": rawHash },
    });
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "seed.sql"), raw);
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

  it.live("--include-roles without a roles.sql pushes migrations and skips globals", () => {
    // Go's push only globs supabase/roles.sql when it exists; an absent file is
    // silently skipped (no error, no "Seeding globals" line) and the rest pushes.
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Seeding globals");
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.live("emits the seeded file paths in the json success payload", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, includeSeed: true }).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["upToDate"]).toBe(false);
      expect(success?.data?.["migrations"]).toEqual(["20240101000000_test.sql"]);
      expect(success?.data?.["seeds"]).toEqual(["supabase/seed.sql"]);
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

  it.live("decrypts an encrypted vault secret keyed by the project .env (not process.env)", () => {
    // Regression: the old point-of-use vault decryption keyed only on `process.env`, so a
    // `DOTENV_PRIVATE_KEY` present only in the project `.env` failed to decrypt. Go's config
    // load merges the project `.env` into the key set (`legacyCheckDbToml`), so it resolves.
    const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const ENCRYPTED =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
    const { layer, out, conn } = setup(tmp.current, {
      toml: `project_id = "test"\n\n[db.vault]\nmy_secret = "${ENCRYPTED}"\n`,
      files: {
        ...migrationFile("20240101000000"),
        "supabase/.env": `DOTENV_PRIVATE_KEY=${PRIVATE_KEY}\n`,
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Updating vault secrets...");
      // The decrypted plaintext ("value") is written, proving the project-.env key was used.
      const create = conn.queries.find((q) => q.sql === "SELECT vault.create_secret($1, $2)");
      expect(create?.params).toEqual(["value", "my_secret"]);
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

  it.live("auto-confirms pending migrations via SUPABASE_YES set only in the project .env", () => {
    // Go's loadNestedEnv sets project-.env keys before PromptYesNo reads viper YES, so a
    // `SUPABASE_YES` in supabase/.env auto-confirms without any interactive answer.
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), "supabase/.env": "SUPABASE_YES=true\n" },
      // Deliberately no `confirm` responses — the prompt must be auto-confirmed.
    });
    return Effect.gen(function* () {
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
        // Config now loads through the Go-parity reader (`legacyCheckDbToml`), so a malformed
        // config aborts with Go's `failed to load config` message (the reader path), same as
        // the other db commands (diff/dump/pull/migration).
        expect(JSON.stringify(exit.cause)).toContain("failed to load config");
      }
    });
  });

  it.live("loads a Go-style env() boolean in config (no ProjectConfigParseError)", () => {
    // Regression for the strict @supabase/config loader rejecting `enabled = "env(VAR)"`:
    // Go decodes it via env-expansion + strconv.ParseBool, so the config must load and the
    // migration proceed. Previously native push aborted before the Go-compatible parse ran.
    const previous = process.env["SEED_ENABLED"];
    process.env["SEED_ENABLED"] = "true";
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nenabled = "env(SEED_ENABLED)"\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SEED_ENABLED"];
          else process.env["SEED_ENABLED"] = previous;
        }),
      ),
    );
  });

  it.live("a matched remote block's migrations.enabled beats the shell env override", () => {
    // Go merges a matched [remotes.<ref>] block at viper's override tier (`v.Set`), which
    // sits ABOVE AutomaticEnv — so `[remotes.preview.db.migrations] enabled = false` wins
    // over `SUPABASE_DB_MIGRATIONS_ENABLED=true` and the push skips migrations. (Before the
    // config-reader convergence, push resolved this gate env-first and wrongly applied.)
    const previous = process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
    process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = "true";
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${LEGACY_VALID_REF}"\n\n[remotes.preview.db.migrations]\nenabled = false\n`,
      files: migrationFile("20240101000000"),
      args: ["db", "push", "--linked"],
      isLocal: false,
      projectRef: LEGACY_VALID_REF,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, local: false, linked: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Skipping migrations because it is disabled");
      expect(out.stderrText).not.toContain("Applying migration 20240101000000");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
          else process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = previous;
        }),
      ),
    );
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
