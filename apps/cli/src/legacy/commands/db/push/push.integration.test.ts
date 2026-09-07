import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
  legacySequentialExecBatch,
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
  type LegacyDbSession,
} from "../../../shared/legacy-db-connection.service.ts";
import { legacyDbPush } from "./push.handler.ts";
import type { LegacyDbPushFlags } from "./push.command.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";
const READ_VAULT = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";

const FLAG_PROJECT_REF = "flagflagflagflagflag";

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
  skipVault: false,
  dryRun: false,
  dbUrl: Option.none(),
  linked: false,
  local: true,
  projectRef: Option.none(),
  password: Option.none(),
};

function mockResolver(
  opts: { isLocal?: boolean; onResolve?: (flags: LegacyDbConfigFlags) => void } = {},
) {
  const calls: Array<LegacyDbConfigFlags> = [];
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags: LegacyDbConfigFlags) =>
      Effect.sync(() => {
        calls.push(flags);
        opts.onResolve?.(flags);
        return {
          conn: LOCAL_CONN,
          isLocal: opts.isLocal ?? true,
        } satisfies LegacyResolvedDbConfig;
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return { layer, calls };
}

function mockConnection(opts: {
  remoteMigrations?: ReadonlyArray<string>;
  remoteSeeds?: Readonly<Record<string, string>>;
  vaultRows?: ReadonlyArray<{ id: string; name: string }>;
  noSeedTable?: boolean;
  failExec?: string;
  failExecWith?: { message: string; code?: string; detail?: string; position?: number };
}) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () => {
      const session: LegacyDbSession = {
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, LegacyDbExecError> =>
          Effect.suspend((): Effect.Effect<void, LegacyDbExecError> => {
            execs.push(sql);
            if (opts.failExec !== undefined && sql === opts.failExec) {
              return Effect.fail(
                new LegacyDbExecError(
                  opts.failExecWith ?? { message: "ERROR: boom (SQLSTATE 42601)" },
                ),
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
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => legacySequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
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
    failExecWith?: { message: string; code?: string; detail?: string; position?: number };
    noProjectId?: boolean;
    // Simulates the real `LegacyDbConfigResolver`'s own "Initialising login
    // role..." stderr line (`legacy-db-config.layer.ts`'s `initLoginRole`),
    // fired as part of `resolve()`'s own connection-resolution work — i.e.
    // strictly before `legacyDbPushCore` (and its "DRY RUN: …" line) ever runs.
    // `mockResolver` is otherwise silent, so tests pin the established output
    // ordering against this stand-in line.
    simulateInitialisingLoginRole?: boolean;
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
    // Go's `loadProjectRef` gives `--project-ref` top precedence, short-circuiting
    // BEFORE the "not linked" failure — mirror that here so a test can prove the
    // flag resolves a ref even when the workdir would otherwise fail to link.
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(
              new LegacyProjectNotLinkedError({
                message: "Cannot find project ref. Have you run supabase link?",
              }),
            )
          : Effect.succeed(opts.projectRef ?? LEGACY_VALID_REF),
    promptProjectRef: () => Effect.succeed(opts.projectRef ?? LEGACY_VALID_REF),
  });

  const resolver = mockResolver({
    isLocal: opts.isLocal ?? true,
    onResolve:
      opts.simulateInitialisingLoginRole === true
        ? () => {
            out.rawChunks.push({ text: "Initialising login role...\n", stream: "stderr" });
          }
        : undefined,
  });
  const layer = Layer.mergeAll(
    out.layer,
    conn.layer,
    resolver.layer,
    mockLegacyCliSettings({
      workdir,
      ...(opts.noProjectId === true ? { projectId: Option.none() } : {}),
    }),
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
  return {
    layer,
    out,
    conn,
    telemetry,
    linkedCache,
    resolver,
  };
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
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.live("reports up to date when an 8-digit and 14-digit version share a prefix (#6036)", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20260420"), ...migrationFile("20260420010000") },
      remoteMigrations: ["20260420", "20260420010000"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("Local database is up to date.\n");
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
      // "supabase db push" is wrapped in Aqua (cyan) on stdout (established output contract).
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

  it.live("honors pg-delta's no-transaction migration header", () => {
    const set = "SET check_function_bodies = off";
    const action = "DROP SUBSCRIPTION app_events";
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile(
        "20240101000000",
        `-- pg-delta: transaction=false\n${set};\n${action};\nRESET ALL;`,
      ),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const setupCommit = conn.execs.indexOf("COMMIT");
      const setIndex = conn.execs.indexOf(`-- pg-delta: transaction=false\n${set}`);
      const actionIndex = conn.execs.indexOf(action);
      const cleanupIndex = conn.execs.lastIndexOf("RESET ALL");

      expect(conn.execs.filter((sql) => sql === "BEGIN")).toHaveLength(1);
      expect(conn.execs.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(setIndex).toBeGreaterThan(setupCommit);
      expect(actionIndex).toBeGreaterThan(setIndex);
      expect(cleanupIndex).toBeGreaterThan(actionIndex);
      expect(
        conn.queries.some((query) => query.sql.includes("INSERT INTO supabase_migrations")),
      ).toBe(true);
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

  it.live("skips vault decryption in dry-run mode with --skip-vault", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:not-valid"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, dryRun: true, skipVault: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Would push these migrations:");
      expect(conn.queries.some((query) => query.sql.includes("vault."))).toBe(false);
      expect(conn.execs).toEqual([]);
    });
  });

  it.live(
    "prints the DRY RUN heads-up line after the connection resolves, not before (Go's push.Run order)",
    () => {
      // The connection-resolution phase (which prints "Initialising login
      // role..." when minting a temp role) runs BEFORE the push itself runs —
      // and "DRY RUN: …" is the literal first line the push prints, so it
      // prints AFTER that resolution output, never before.
      // `simulateInitialisingLoginRole` stands in for the real resolver's
      // stderr line (the fake resolver is otherwise silent) so this asserts on
      // actual accumulated stderr text ordering, not internal call timing.
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        simulateInitialisingLoginRole: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbPush({ ...DEFAULT_FLAGS, dryRun: true }).pipe(Effect.provide(layer));
        const loginRoleIndex = out.stderrText.indexOf("Initialising login role...");
        const dryRunIndex = out.stderrText.indexOf(
          "DRY RUN: migrations will *not* be pushed to the database.",
        );
        expect(loginRoleIndex).toBeGreaterThanOrEqual(0);
        expect(dryRunIndex).toBeGreaterThan(loginRoleIndex);
        // ...and, in turn, before the connect step's own progress line.
        const connectingIndex = out.stderrText.indexOf("Connecting to local database...");
        expect(connectingIndex).toBeGreaterThan(dryRunIndex);
      });
    },
  );

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
        expect(JSON.stringify(exit.cause)).toContain("migration repair --local --status reverted");
        expect(JSON.stringify(exit.cause)).toContain("supabase db pull --local");
      }
      expect(out).toBeDefined();
    });
  });

  it.live("keeps repair suggestions targetless for an explicit local database URL", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "push", "--db-url", dbUrl],
      remoteMigrations: ["20240101000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush({
        ...DEFAULT_FLAGS,
        dbUrl: Option.some(dbUrl),
        local: false,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(JSON.stringify(exit)).toContain("migration repair --status reverted");
      expect(JSON.stringify(exit)).not.toContain("migration repair --local");
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
    // A matched directory is walked and its regular `.sql` files seeded
    // recursively; non-.sql files are skipped. Without dir expansion the
    // directory path reached `readFileString(<dir>)` and failed.
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
    // The seed file hashes the raw byte stream; a UTF-8 string decode would
    // replace the invalid bytes and change the hash. Write invalid UTF-8 and
    // pre-seed the remote with the RAW-byte sha256 — the push must treat it as
    // already-applied (byte hash matches), not re-run it. A string-decoded hash
    // here would differ and mark the seed dirty.
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
    // `supabase/roles.sql` is only globbed when it exists; an absent file is
    // silently skipped (no error, no "Seeding globals" line) and the rest
    // pushes.
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
    const { layer, out, conn, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nexisting = "v1"\nfresh = "v2"\n',
      files: migrationFile("20240101000000"),
      // `existing` already present remotely → update; `fresh` → create.
      vaultRows: [{ id: "id-1", name: "existing" }],
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Updating vault secrets...");
      expect(resolver.calls[0]?.resolveVaultSecrets).toBe(true);
      const sqls = conn.queries.map((q) => q.sql);
      expect(sqls).toContain("SELECT vault.update_secret($1, $2)");
      expect(sqls).toContain("SELECT vault.create_secret($1, $2)");
    });
  });

  it.live("applies migrations without touching vault when --skip-vault is set", () => {
    const { layer, out, conn, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nexisting = "v1"\nfresh = "v2"\n',
      files: migrationFile("20240101000000"),
      vaultRows: [{ id: "id-1", name: "existing" }],
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({ ...DEFAULT_FLAGS, skipVault: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Updating vault secrets...");
      expect(resolver.calls[0]?.resolveVaultSecrets).toBe(false);
      expect(conn.queries.some((query) => query.sql.includes("vault."))).toBe(false);
      expect(
        conn.queries.some((query) => query.sql.includes("INSERT INTO supabase_migrations")),
      ).toBe(true);
    });
  });

  it.live("does not decrypt vault secrets skipped by --skip-vault", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:not-valid"\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush({ ...DEFAULT_FLAGS, skipVault: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(conn.queries.some((query) => query.sql.includes("vault."))).toBe(false);
    });
  });

  it.live("still validates non-vault secrets with --skip-vault", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db]\nroot_key = "encrypted:not-valid"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush({ ...DEFAULT_FLAGS, skipVault: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse config:");
      expect(out.stderrText).not.toContain("Connecting to local database...");
      expect(conn.queries).toEqual([]);
    });
  });

  it.live("decrypts an encrypted vault secret keyed by the project .env (not process.env)", () => {
    // Regression: the old point-of-use vault decryption keyed only on `process.env`, so a
    // `DOTENV_PRIVATE_KEY` present only in the project `.env` failed to decrypt. The
    // config load merges the project `.env` into the key set (`legacyCheckDbToml`), so
    // it resolves.
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
      const error = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.flip);
      // A server error without position/detail keeps the plain error layout.
      expect(error._tag).toBe("LegacyDbPushApplyError");
      expect(error.message).toBe("ERROR: boom (SQLSTATE 42601)\nAt statement: 0\nBOOM");
    });
  });

  it.live("renders Go's caret, Detail line, and 42704 extension hint on a failed migration", () => {
    // Established failure-rendering format: the `^` caret under the
    // server-reported error position, the `Detail` line, and the
    // undefined-object extension hint.
    const stat = "CREATE TABLE test (path ltree NOT NULL)";
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000", `${stat};`),
      failExec: stat,
      failExecWith: {
        message: 'ERROR: type "ltree" does not exist (SQLSTATE 42704)',
        code: "42704",
        detail: "Detail from the server.",
        position: 25,
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      const error = yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.flip);
      expect(error._tag).toBe("LegacyDbPushApplyError");
      expect(error.message).toBe(
        'ERROR: type "ltree" does not exist (SQLSTATE 42704)\n' +
          "Detail from the server.\n" +
          "\n" +
          "Hint: This type may be defined in a schema that's not in your search_path.\n" +
          "      Use schema-qualified type references to avoid this error:\n" +
          "        CREATE TABLE example (col extensions.ltree);\n" +
          "      Learn more: supabase migration new --help\n" +
          "At statement: 0\n" +
          "CREATE TABLE test (path ltree NOT NULL)\n" +
          "                        ^",
      );
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
      // The roles path is wrapped in Bold (ANSI).
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
      // No config.toml written → loadCliConfig returns null → default config
      // (migrations enabled), and the vault document is absent.
      yield* legacyDbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.live("auto-confirms pending migrations via SUPABASE_YES set only in the project .env", () => {
    // The project `.env` is applied before the history prompt reads
    // `SUPABASE_YES`, so a `SUPABASE_YES` in supabase/.env auto-confirms without
    // any interactive answer.
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
        // Config loads through the shared reader (`legacyCheckDbToml`), so a
        // malformed config aborts with the established `failed to load config`
        // message (the reader path), same as the other db commands
        // (diff/dump/pull/migration).
        expect(JSON.stringify(exit.cause)).toContain("failed to load config");
      }
    });
  });

  it.live("loads a Go-style env() boolean in config (no CliConfigParseError)", () => {
    // Regression for the strict @supabase/config loader rejecting `enabled = "env(VAR)"`:
    // env-expansion + boolean parsing must resolve it, so the config loads and the
    // migration proceeds. Previously native push aborted before that parse ran.
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
    // A matched [remotes.<ref>] block overrides the shell env, so
    // `[remotes.preview.db.migrations] enabled = false` wins over
    // `SUPABASE_DB_MIGRATIONS_ENABLED=true` and the push skips migrations.
    // (Before the config-reader convergence, push resolved this gate
    // env-first and wrongly applied.)
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

  it.live("pushes to the project given via --project-ref without a linked workdir", () => {
    // No `.temp/project-ref` and the resolver's own ref-file fallback is
    // simulated as failing (`linkedFails`) — only the flag can resolve a ref.
    const { layer, out, linkedCache, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      args: ["db", "push", "--linked"],
      isLocal: false,
      linkedFails: true,
      format: "json",
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({
        ...DEFAULT_FLAGS,
        local: false,
        linked: true,
        projectRef: Option.some(FLAG_PROJECT_REF),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Connecting to remote database...");
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(FLAG_PROJECT_REF);
      expect(resolver.calls[0]?.linkedProjectRef).toEqual(Option.some(FLAG_PROJECT_REF));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["migrations"]).toEqual(["20240101000000_test.sql"]);
    });
  });

  it.live("--project-ref drives which [remotes.<ref>] block merges into config", () => {
    // The `[remotes.staging]` block's `project_id` matches the FLAG ref, not the
    // resolver's own `LEGACY_VALID_REF` fallback — the override only announces if
    // the flag (not the fallback) actually resolved the ref config merges against.
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.staging]\nproject_id = "${FLAG_PROJECT_REF}"\n`,
      args: ["db", "push", "--linked"],
      isLocal: false,
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({
        ...DEFAULT_FLAGS,
        local: false,
        linked: true,
        projectRef: Option.some(FLAG_PROJECT_REF),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Loading config override: [remotes.staging]");
    });
  });

  it.live("--project-ref overrides an already-linked workdir's project ref", () => {
    const { layer, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      args: ["db", "push", "--linked"],
      isLocal: false,
      // The workdir is linked to LEGACY_VALID_REF (e.g. via .temp/project-ref) —
      // the flag must win over it.
      projectRef: LEGACY_VALID_REF,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbPush({
        ...DEFAULT_FLAGS,
        local: false,
        linked: true,
        projectRef: Option.some(FLAG_PROJECT_REF),
      }).pipe(Effect.provide(layer));
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(FLAG_PROJECT_REF);
      expect(linkedCache.cachedRef).not.toBe(LEGACY_VALID_REF);
    });
  });

  it.live("rejects --project-ref combined with an explicit --local target", () => {
    const { layer, conn, resolver, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      args: ["db", "push", "--local"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbPush({
        ...DEFAULT_FLAGS,
        projectRef: Option.some(FLAG_PROJECT_REF),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      expect(conn.execs).toEqual([]);
      expect(resolver.calls).toEqual([]);
      expect(linkedCache.cached).toBe(false);
    });
  });
});
