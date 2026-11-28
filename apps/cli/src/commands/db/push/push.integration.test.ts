import { createHash } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import {
  NO_TARGET,
  describeDbTargetSelection,
} from "../../../../tests/helpers/db-target-selection.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import { branchListApi } from "../../../../tests/helpers/remote-selection.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  realDbConfigResolver,
  realLinkedProjectCache,
  recordingProjectHttpClient,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { configValuesLayer, flagInput } from "../../../../tests/helpers/config-values-layer.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
  withConfigEnv,
  withEmptyConfigEnv,
  withEnvVar,
} from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag, OutputFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type PgConnInput,
  type DbSession,
} from "../../../command-internal/db-connection.service.ts";
import { dbPush } from "./push.handler.ts";
import type { DbPushFlags } from "./push.command.ts";
import { DbPushApplyError } from "./push.errors.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";
const READ_VAULT = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";

const FLAG_PROJECT_REF = "flagflagflagflagflag";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const DEFAULT_FLAGS: DbPushFlags = {
  includeAll: false,
  includeRoles: false,
  includeSeed: Option.none(),
  skipVault: false,
  skipChecks: false,
  dryRun: false,
  ...NO_TARGET,
  password: Option.none(),
};

const REMOTE_LINKED: DbPushFlags["remote"] = Option.some({ _tag: "Linked" });

function mockResolver(
  opts: { isLocal?: boolean; onResolve?: (input: DbConnectionInput) => void } = {},
) {
  const calls: Array<DbConnectionInput> = [];
  const layer = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) =>
      Effect.sync(() => {
        calls.push(input);
        opts.onResolve?.(input);
        return {
          conn: LOCAL_CONN,
          isLocal: opts.isLocal ?? input.target.kind !== "linked",
          ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
          target: input.target,
        } satisfies ResolvedDbConnection;
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
  const layer = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, DbExecError> =>
          Effect.suspend((): Effect.Effect<void, DbExecError> => {
            execs.push(sql);
            if (opts.failExec !== undefined && sql === opts.failExec) {
              return Effect.fail(
                new DbExecError(opts.failExecWith ?? { message: "ERROR: boom (SQLSTATE 42601)" }),
              );
            }
            return Effect.void;
          }),
        query: (
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DbExecError> =>
          Effect.suspend((): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DbExecError> => {
            queries.push({ sql, params });
            if (sql === LIST_MIGRATIONS) {
              return Effect.succeed((opts.remoteMigrations ?? []).map((version) => ({ version })));
            }
            if (sql === SELECT_SEEDS) {
              if (opts.noSeedTable === true) {
                return Effect.fail(
                  new DbExecError({
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
          }),
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
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
    interactive?: boolean;
    yes?: boolean;
    includeSeed?: boolean;
    env?: Readonly<Record<string, string>>;
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
    // Simulates the real `DbConfigResolver`'s "Initialising login role..." stderr line,
    // fired as part of `resolveConnection()`'s own work, strictly before `dbPushCore`
    // runs; `mockResolver` is otherwise silent, so tests pin output ordering against it.
    simulateInitialisingLoginRole?: boolean;
    /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
    realLayers?: boolean;
  },
) {
  const workdirLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (opts.toml !== undefined) {
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), opts.toml);
      }
      for (const [rel, content] of Object.entries(opts.files ?? {})) {
        const abs = path.join(workdir, rel);
        yield* fs.makeDirectory(path.dirname(abs), { recursive: true });
        yield* fs.writeFileString(abs, content);
      }
    }),
  ).pipe(Layer.provide(BunServices.layer));

  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: opts.interactive,
    promptConfirmResponses: opts.confirm,
  });
  const conn = mockConnection(opts);
  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();

  const projectRefLayer = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(opts.projectRef ?? VALID_REF),
    resolveForLink: () => Effect.succeed(opts.projectRef ?? VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed({ ref: flagValue.value, source: "flag", matchesLinkedRef: false })
        : opts.linkedFails === true
          ? Effect.fail(
              new ProjectRefNotLinkedError({
                message: "Cannot find project ref. Have you run supabase link?",
              }),
            )
          : Effect.succeed({
              ref: opts.projectRef ?? VALID_REF,
              source: "file",
              matchesLinkedRef: true,
            }),
    resolveOptional: () => Effect.succeed(Option.some(opts.projectRef ?? VALID_REF)),
    promptProjectRef: () => Effect.succeed(opts.projectRef ?? VALID_REF),
  });

  const resolver = mockResolver({
    isLocal: opts.isLocal,
    onResolve:
      opts.simulateInitialisingLoginRole === true
        ? () => {
            out.rawChunks.push({ text: "Initialising login role...\n", stream: "stderr" });
          }
        : undefined,
  });
  const projectHttp = recordingProjectHttpClient(VALID_REF);
  const layer = Layer.mergeAll(
    workdirLayer,
    out.layer,
    configValuesLayer({
      output: out.layer,
      flags: opts.includeSeed === true ? [flagInput("db.seed.enabled", "include-seed", true)] : [],
      env: opts.env,
    }),
    conn.layer,
    opts.realLayers === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: conn.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : resolver.layer,
    mockCommandSettings({
      workdir,
      ...(opts.noProjectId === true ? { projectId: Option.none() } : {}),
    }),
    BunServices.layer,
    mockTty({ stdinIsTty: opts.interactive ?? true }),
    mockStdin(opts.interactive ?? true),
    Layer.succeed(CliArgs, { args: ["db", "push"] }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
    Layer.succeed(DnsResolverFlag, "native"),
    projectRefLayer,
    telemetry.layer,
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: projectHttp.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : linkedCache.layer,
  );
  return {
    layer,
    out,
    conn,
    telemetry,
    linkedCache,
    resolver,
    projectHttp,
  };
}

const failSuggestion = (
  exit: Exit.Exit<unknown, { readonly message: string; readonly suggestion?: string }>,
): string | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error.suggestion : undefined;

const MIGRATION_DIR = "supabase/migrations";
const migrationFile = (version: string, body = "create table t ();") => ({
  [`${MIGRATION_DIR}/${version}_test.sql`]: body,
});

describe("db push", () => {
  const tmp = useTempWorkdir("supabase-db-push-");

  it.effect("reports up to date when nothing is pending (text)", () => {
    const { layer, out, conn } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("Local database is up to date.\n");
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.effect(
    "reports up to date when an 8-digit and 14-digit version share a prefix (#6036)",
    () => {
      const { layer, out, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: { ...migrationFile("20260420"), ...migrationFile("20260420010000") },
        remoteMigrations: ["20260420", "20260420010000"],
      });
      return Effect.gen(function* () {
        const exit = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stdoutText).toBe("Local database is up to date.\n");
        expect(conn.execs).not.toContain("BEGIN");
      });
    },
  );

  it.effect("emits a json result for an up-to-date run", () => {
    const { layer, out } = setup(tmp.current, { toml: 'project_id = "test"\n', format: "json" });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["upToDate"]).toBe(true);
      expect(success?.data?.["migrations"]).toEqual([]);
    });
  });

  it.effect("applies a pending migration to the local database without asking", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.promptConfirmCalls).toEqual([]);
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(out.stdoutText).toContain("Finished");
      expect(out.stdoutText).toContain("supabase db push");
      expect(conn.execs).toContain("BEGIN");
      expect(conn.execs).toContain("COMMIT");
      expect(conn.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(
        true,
      );
    });
  });

  it.effect("honors pg-delta's no-transaction migration header", () => {
    const set = "SET check_function_bodies = off";
    const action = "DROP SUBSCRIPTION app_events";
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile(
        "20240101000000",
        `-- pg-delta: transaction=false\n${set};\n${action};\nRESET ALL;`,
      ),
    });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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

  it.effect("prints the plan without applying in dry-run mode", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, dryRun: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("DRY RUN: migrations will *not* be pushed to the database.");
      expect(out.stderrText).toContain("Would push these migrations:");
      expect(out.stderrText).toContain("20240101000000_test.sql");
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.effect("skips vault decryption in dry-run mode with --skip-vault", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:not-valid"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, dryRun: true, skipVault: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Would push these migrations:");
      expect(conn.queries.some((query) => query.sql.includes("vault."))).toBe(false);
      expect(conn.execs).toEqual([]);
    });
  });

  it.effect("prints the DRY RUN heads-up line after the connection resolves, not before", () => {
    // `simulateInitialisingLoginRole` stands in for the real resolver's stderr line
    // (the fake resolver is otherwise silent), so this asserts on actual stderr
    // ordering, not internal call timing.
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      simulateInitialisingLoginRole: true,
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, dryRun: true }).pipe(Effect.provide(layer));
      const loginRoleIndex = out.stderrText.indexOf("Initialising login role...");
      const dryRunIndex = out.stderrText.indexOf(
        "DRY RUN: migrations will *not* be pushed to the database.",
      );
      expect(loginRoleIndex).toBeGreaterThanOrEqual(0);
      expect(dryRunIndex).toBeGreaterThan(loginRoleIndex);
    });
  });

  it.effect("fails with a repair suggestion when remote has versions missing locally", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      remoteMigrations: ["20240101000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "Remote migration versions not found in local migrations directory.",
        );
        expect(failSuggestion(exit)).toContain(
          "migration repair --status reverted 20240101000000\n",
        );
        expect(failSuggestion(exit)).toContain("supabase db pull\n");
      }
      expect(out).toBeDefined();
    });
  });

  it.effect("points repair suggestions at an explicit database URL without echoing it", () => {
    const dbUrl = "postgresql://postgres:s3cret@127.0.0.1:54322/postgres";
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      remoteMigrations: ["20240101000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* dbPush({
        ...DEFAULT_FLAGS,
        remote: Option.some({ _tag: "DbUrl", url: dbUrl } as const),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(failSuggestion(exit)).toContain(
        "migration repair --status reverted 20240101000000 --remote=<db-url>",
      );
      expect(failSuggestion(exit)).toContain("supabase db pull --remote=<db-url>");
      expect(failSuggestion(exit)).not.toContain("s3cret");
    });
  });

  it.effect("points repair suggestions at the linked project", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      remoteMigrations: ["20240101000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(failSuggestion(exit)).toContain(
        "migration repair --status reverted 20240101000000 --remote",
      );
      expect(failSuggestion(exit)).toContain("supabase db pull --remote");
      expect(failSuggestion(exit)).not.toContain("--local");
    });
  });

  it.effect("fails with an --include-all suggestion for out-of-order local migrations", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      // 0101 is local-only and ordered before the already-applied remote 0202.
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      remoteMigrations: ["20240202000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(failSuggestion(exit)).toContain("--include-all");
      }
    });
  });

  it.effect("pushes out-of-order migrations with --include-all", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      remoteMigrations: ["20240202000000"],
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeAll: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.effect("skips migrations when disabled in config and reports up to date", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.migrations]\nenabled = false\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain(
        "Skipping migrations because it is disabled in config.toml for project:",
      );
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    });
  });

  it.effect("seeds a new file with --include-seed", () => {
    const { layer, out, conn } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
      expect(
        conn.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
    });
  });

  it.effect("expands a directory in [db.seed].sql_paths to its sorted .sql children", () => {
    // Directories are walked recursively; without expansion the path would reach
    // `readFileString(<dir>)` and fail.
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n\n[db.seed]\nsql_paths = ["seeds"]\n',
      files: {
        "supabase/seeds/a.sql": "insert into t values (1);",
        "supabase/seeds/nested/b.sql": "insert into t values (2);",
        "supabase/seeds/notes.txt": "not a seed",
      },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Seeding data from supabase/seeds/a.sql...");
      expect(out.stderrText).toContain("Seeding data from supabase/seeds/nested/b.sql...");
      expect(out.stderrText).not.toContain("notes.txt");
    });
  });

  it.effect("reports seed files up to date when hash matches remote", () => {
    // sha256 of the seed body must match the remote hash to be skipped.
    const body = "insert into t values (1);";
    const hash = createHash("sha256").update(body).digest("hex");
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": body },
      remoteSeeds: { "supabase/seed.sql": hash },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    });
  });

  it.effect("hashes a non-UTF-8 seed file by its raw bytes", () => {
    // Writing invalid UTF-8 and pre-seeding the remote with the raw-byte sha256 proves
    // the push hashes bytes, not a UTF-8 decode (which would replace invalid bytes and
    // mark the seed dirty).
    const raw = Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0xfe, 0x00, 0x01, 0x0a]);
    const rawHash = createHash("sha256").update(raw).digest("hex");
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      remoteSeeds: { "supabase/seed.sql": rawHash },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFile(path.join(tmp.current, "supabase", "seed.sql"), raw);
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("seeds despite db.seed.enabled = false when --include-seed is passed", () => {
    const { layer, conn } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n\n[db.seed]\nenabled = false\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(
        conn.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
    });
  });

  it.effect("does not seed without --include-seed even when SUPABASE_DB_SEED_ENABLED=true", () => {
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      env: { SUPABASE_DB_SEED_ENABLED: "true" },
    });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(conn.queries.some((q) => q.sql === SELECT_SEEDS)).toBe(false);
    });
  });

  describe("hosted consent on a linked project", () => {
    const linked = { ...DEFAULT_FLAGS, remote: REMOTE_LINKED };
    const allFlags = { ...linked, includeRoles: true, includeSeed: Option.some(true) };
    const allFiles = {
      ...migrationFile("20240101000000"),
      "supabase/roles.sql": "create role app;",
      "supabase/seed.sql": "insert into t values (1);",
    };
    const seeded = (conn: ReturnType<typeof mockConnection>) =>
      conn.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files"));
    const previewToml = (remoteBlock = "") =>
      `project_id = "base"\n\n[remotes.preview]\nproject_id = "${VALID_REF}"\n${remoteBlock}`;

    it.effect("asks once for roles, migrations and seeds together, defaulting to no", () => {
      const { layer, out, conn } = setup(tmp.current, {
        includeSeed: true,
        toml: 'project_id = "test"\n',
        files: allFiles,
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* dbPush(allFlags).pipe(Effect.provide(layer));
        expect(out.promptConfirmCalls).toHaveLength(1);
        expect(out.promptConfirmCalls[0]?.message).toBe(
          "Create custom roles, apply 1 migration and seed 1 file?",
        );
        expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
        expect(out.stderrText).toContain("20240101000000_test.sql");
        expect(out.stderrText).toContain("supabase/seed.sql");
        expect(conn.execs).toContain("BEGIN");
        expect(seeded(conn)).toBe(true);
      });
    });

    it.effect("runs under --yes without asking and says what it confirmed", () => {
      const { layer, out, conn } = setup(tmp.current, {
        includeSeed: true,
        toml: 'project_id = "test"\n',
        files: allFiles,
        format: "json",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPush(allFlags).pipe(Effect.provide(layer));
        expect(out.promptConfirmCalls).toEqual([]);
        expect(out.stderrText).toContain(
          "Confirmed by --yes: Create custom roles, apply 1 migration and seed 1 file",
        );
        expect(conn.execs).toContain("BEGIN");
        expect(seeded(conn)).toBe(true);
      });
    });

    it.effect("asks nothing for --dry-run", () => {
      const { layer, out, conn } = setup(tmp.current, {
        includeSeed: true,
        toml: 'project_id = "test"\n',
        files: allFiles,
        format: "json",
      });
      return Effect.gen(function* () {
        yield* dbPush({ ...allFlags, dryRun: true }).pipe(Effect.provide(layer));
        expect(out.promptConfirmCalls).toEqual([]);
        expect(out.stderrText).toContain("Would push these migrations:");
        expect(conn.execs).not.toContain("BEGIN");
      });
    });

    it.effect("asks nothing when the linked database is already up to date", () => {
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        format: "json",
      });
      return Effect.gen(function* () {
        yield* dbPush(linked).pipe(Effect.provide(layer));
        expect(out.promptConfirmCalls).toEqual([]);
        expect(out.messages.find((m) => m.type === "success")?.data?.["upToDate"]).toBe(true);
      });
    });

    it.effect(
      "names the matched [remotes.*] block and what enabled seeding in the same question",
      () => {
        const { layer, out, conn } = setup(tmp.current, {
          includeSeed: true,
          toml: previewToml(),
          files: { "supabase/seed.sql": "insert into t values (1);" },
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* dbPush({ ...linked, includeSeed: Option.some(true) }).pipe(Effect.provide(layer));
          expect(out.promptConfirmCalls).toHaveLength(1);
          expect(out.stderrText).toContain(
            "Seed 1 file into [remotes.preview] (seeding enabled by --include-seed)",
          );
          expect(seeded(conn)).toBe(true);
        });
      },
    );

    it.effect(
      "does not credit --include-seed when the matched remote block enables seeding",
      () => {
        const { layer, out, conn } = setup(tmp.current, {
          includeSeed: true,
          toml: previewToml("\n[remotes.preview.db.seed]\nenabled = true\n"),
          files: { "supabase/seed.sql": "insert into t values (1);" },
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* dbPush({ ...linked, includeSeed: Option.some(true) }).pipe(Effect.provide(layer));
          expect(out.stderrText).toContain("Seed 1 file into [remotes.preview]");
          expect(out.stderrText).not.toContain("seeding enabled by");
          expect(seeded(conn)).toBe(true);
        });
      },
    );

    it.effect("lets the connection clear a network ban only under --yes", () =>
      Effect.gen(function* () {
        const withYes = setup(tmp.current, { toml: 'project_id = "test"\n', yes: true });
        yield* dbPush(linked).pipe(Effect.provide(withYes.layer));
        expect(Option.isSome(withYes.resolver.calls[0]!.networkBanRemoval)).toBe(true);

        const withoutYes = setup(tmp.current, { toml: 'project_id = "test"\n' });
        yield* withEmptyConfigEnv(dbPush(linked).pipe(Effect.provide(withoutYes.layer)));
        expect(Option.isNone(withoutYes.resolver.calls[0]!.networkBanRemoval)).toBe(true);
      }),
    );
  });

  it.effect("creates custom roles with --include-roles", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Seeding globals from roles.sql...");
    });
  });

  it.effect("--include-roles without a roles.sql pushes migrations and skips globals", () => {
    // An absent roles.sql is silently skipped (no error, no "Seeding globals" line).
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Seeding globals");
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.effect("emits the seeded file paths in the json success payload", () => {
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      format: "json",
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["upToDate"]).toBe(false);
      expect(success?.data?.["migrations"]).toEqual(["20240101000000_test.sql"]);
      expect(success?.data?.["seeds"]).toEqual(["supabase/seed.sql"]);
    });
  });

  it.effect("reports schema migrations up to date when only roles are pushed", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeRoles: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Schema migrations are up to date.");
    });
  });

  it.effect("re-hashes a dirty seed without re-running its statements", () => {
    const { layer, out, conn } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      // Remote hash differs → dirty.
      remoteSeeds: { "supabase/seed.sql": "stalehash" },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Updating seed hash to supabase/seed.sql...");
      expect(conn.execs).not.toContain("insert into t values (1);");
    });
  });

  it.effect("treats every seed as pending when the seed_files table is absent", () => {
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      files: { "supabase/seed.sql": "insert into t values (1);" },
      noSeedTable: true,
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
    });
  });

  it.effect("warns and reports up to date when no seed files match", () => {
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n\n[db.seed]\nsql_paths = ["missing.sql"]\n',
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("WARN: no files matched pattern: supabase/missing.sql");
      expect(out.stdoutText).toBe("Local database is up to date.\n");
    });
  });

  it.effect("reports seed files up to date when migrations push but no seeds match", () => {
    const { layer, out } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n\n[db.seed]\nsql_paths = ["missing.sql"]\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, includeSeed: Option.some(true) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Seed files are up to date.");
    });
  });

  it.effect("upserts vault secrets (update existing, create new) before migrating", () => {
    const { layer, out, conn, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nexisting = "v1"\nfresh = "v2"\n',
      files: migrationFile("20240101000000"),
      // `existing` already present remotely → update; `fresh` → create.
      vaultRows: [{ id: "id-1", name: "existing" }],
    });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Updating vault secrets...");
      expect(resolver.calls[0]?.resolveVaultSecrets).toBe(true);
      const sqls = conn.queries.map((q) => q.sql);
      expect(sqls).toContain("SELECT vault.update_secret($1, $2)");
      expect(sqls).toContain("SELECT vault.create_secret($1, $2)");
    });
  });

  it.effect("applies migrations without touching vault when --skip-vault is set", () => {
    const { layer, out, conn, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nexisting = "v1"\nfresh = "v2"\n',
      files: migrationFile("20240101000000"),
      vaultRows: [{ id: "id-1", name: "existing" }],
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, skipVault: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Updating vault secrets...");
      expect(resolver.calls[0]?.resolveVaultSecrets).toBe(false);
      expect(conn.queries.some((query) => query.sql.includes("vault."))).toBe(false);
      expect(
        conn.queries.some((query) => query.sql.includes("INSERT INTO supabase_migrations")),
      ).toBe(true);
    });
  });

  it.effect("does not decrypt vault secrets skipped by --skip-vault", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:not-valid"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      const exit = yield* dbPush({ ...DEFAULT_FLAGS, skipVault: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(conn.queries.some((query) => query.sql.includes("vault."))).toBe(false);
    });
  });

  it.effect("still validates non-vault secrets with --skip-vault", () => {
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db]\nroot_key = "encrypted:not-valid"\n',
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      const exit = yield* dbPush({ ...DEFAULT_FLAGS, skipVault: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain("failed to parse config:");
      expect(conn.queries).toEqual([]);
    });
  });

  it.effect(
    "decrypts an encrypted vault secret keyed by the project .env (not process.env)",
    () => {
      // `DOTENV_PRIVATE_KEY` present only in the project .env must still decrypt — the
      // config load merges the project .env into the key set (`checkDbToml`).
      const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
      const ENCRYPTED =
        "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
      const { layer, out, conn } = setup(tmp.current, {
        toml: `project_id = "test"\n\n[db.vault]\nmy_secret = "${ENCRYPTED}"\n`,
        files: {
          ...migrationFile("20240101000000"),
          "supabase/.env": `DOTENV_PRIVATE_KEY=${PRIVATE_KEY}\n`,
        },
      });
      return Effect.gen(function* () {
        yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Updating vault secrets...");
        // The decrypted plaintext ("value") is written, proving the project-.env key was used.
        const create = conn.queries.find((q) => q.sql === "SELECT vault.create_secret($1, $2)");
        expect(create?.params).toEqual(["value", "my_secret"]);
      });
    },
  );

  it.effect("targets the linked project for a bare --remote", () => {
    const { layer, out, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      projectRef: VALID_REF,
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(Effect.provide(layer));
      expect(resolver.calls[0]).toMatchObject({
        target: { kind: "linked", ref: VALID_REF, source: "file", matchesLinkedRef: true },
        hasPasswordFlag: true,
      });
      expect(out.stdoutText).toBe("Remote database is up to date.\n");
    });
  });

  describeDbTargetSelection("db push", {
    dbUrl: true,
    workdir: () => tmp.current,
    attempt: ({ workdir, target }) => {
      const ctx = setup(workdir, { toml: 'project_id = "test"\n' });
      const branchApi = branchListApi();
      return {
        layer: Layer.merge(ctx.layer, branchApi.layer),
        out: ctx.out,
        run: dbPush({ ...DEFAULT_FLAGS, ...target }),
        target: () => ctx.resolver.calls[0]?.target,
        cachedRef: () => ctx.linkedCache.cachedRef,
        branchLookups: () => branchApi.requests,
        apiRequests: () => branchApi.requests,
      };
    },
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const { layer, projectHttp } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbPush({
        ...DEFAULT_FLAGS,
        remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const),
      }).pipe(Effect.provide(layer));
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(projectHttp.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "db push",
        activeFlags: { remote: VALID_REF },
        requests: [...asRecordedRequests(requests), ...projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("does not mint a login role when --password is given", () => {
    const { layer, projectHttp } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbPush({
        ...DEFAULT_FLAGS,
        remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const),
        password: Option.some("secret"),
      }).pipe(Effect.provide(layer));
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
      ]);
      assertPermissionDrift({
        command: "db push",
        activeFlags: { remote: VALID_REF, password: true },
        requests: [...asRecordedRequests(requests), ...projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "makes no Management API request for the default local target through the real resolver and cache",
    () => {
      const { layer, projectHttp } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        realLayers: true,
      });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(requests, () => undefined);
        yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(requests).toEqual([]);
        expect(projectHttp.calls).toEqual([]);
        expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(false);
        assertPermissionDrift({
          command: "db push",
          activeFlags: {},
          requests: [],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(BunServices.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect("surfaces an apply error with statement context", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000", "BOOM;"),
      failExec: "BOOM",
    });
    return Effect.gen(function* () {
      const error = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.flip);
      // A server error without position/detail keeps the plain error layout.
      expect(error).toBeInstanceOf(DbPushApplyError);
      expect(error.message).toBe("ERROR: boom (SQLSTATE 42601)\nAt statement: 0\nBOOM");
    });
  });

  it.effect(
    "renders the caret, Detail line, and 42704 extension hint on a failed migration",
    () => {
      // Established failure-rendering format: caret under the error position, Detail
      // line, and undefined-object extension hint.
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
      });
      return Effect.gen(function* () {
        const error = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.flip);
        expect(error).toBeInstanceOf(DbPushApplyError);
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
    },
  );

  it.effect("dry-run lists roles, migrations and seeds without applying", () => {
    const { layer, out, conn } = setup(tmp.current, {
      includeSeed: true,
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/roles.sql": "create role app;",
        "supabase/seed.sql": "insert into t values (1);",
      },
    });
    return Effect.gen(function* () {
      yield* dbPush({
        ...DEFAULT_FLAGS,
        dryRun: true,
        includeRoles: true,
        includeSeed: Option.some(true),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Would create custom roles");
      expect(out.stderrText).toContain("roles.sql");
      expect(out.stderrText).toContain("Would push these migrations:");
      expect(out.stderrText).toContain("Would seed these files:");
      expect(conn.execs).not.toContain("BEGIN");
    });
  });

  it.effect("dry-run with only custom roles lists them without a migration section", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/roles.sql": "create role app;" },
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, dryRun: true, includeRoles: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Would create custom roles");
      expect(out.stderrText).not.toContain("Would push these migrations:");
    });
  });

  it.effect("uses embedded defaults when no config file is present", () => {
    const { layer, out } = setup(tmp.current, {
      files: migrationFile("20240101000000"),
    });
    return Effect.gen(function* () {
      // No config.toml written → the resolved config reports no config file → default config
      // (migrations enabled), and the vault document is absent.
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    });
  });

  it.effect("fails when config.toml cannot be parsed", () => {
    const { layer } = setup(tmp.current, { toml: "this is = = not [[[ valid toml" });
    return Effect.gen(function* () {
      const exit = yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Config loads through the shared reader (`checkDbToml`), same as the other db
        // commands.
        expect(Cause.pretty(exit.cause)).toContain("failed to load config");
      }
    });
  });

  it.effect("loads an env() boolean in config (no CliConfigParseError)", () => {
    // env-expansion + boolean parsing must resolve `env(VAR)` so the config loads and
    // the migration proceeds.
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nenabled = "env(SEED_ENABLED)"\n',
      files: migrationFile("20240101000000"),
      env: { SEED_ENABLED: "true" },
    });
    return Effect.gen(function* () {
      yield* dbPush(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    }).pipe(
      (body) => withEnvVar("SEED_ENABLED", "true", body),
      (body) => withConfigEnv({ SEED_ENABLED: "true" }, body),
    );
  });

  it.effect("the shell env override beats a matched remote block's migrations.enabled", () => {
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${VALID_REF}"\n\n[remotes.preview.db.migrations]\nenabled = false\n`,
      files: migrationFile("20240101000000"),
      projectRef: VALID_REF,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Skipping migrations because it is disabled");
      expect(out.stderrText).toContain("Applying migration 20240101000000");
    }).pipe((body) => withEnvVar("SUPABASE_DB_MIGRATIONS_ENABLED", "true", body));
  });

  it.effect("announces a matching [remotes.*] override on the linked path", () => {
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${VALID_REF}"\n`,
      projectRef: VALID_REF,
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Loading config override: [remotes.preview]");
    });
  });

  it.effect(
    "selects a [remotes.*] block whose project_id is overridden by SUPABASE_REMOTES_<NAME>_PROJECT_ID",
    () => {
      const { layer, out } = setup(tmp.current, {
        toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${FLAG_PROJECT_REF}"\n`,
        projectRef: VALID_REF,
        env: { SUPABASE_REMOTES_PREVIEW_PROJECT_ID: VALID_REF },
      });
      return Effect.gen(function* () {
        yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Loading config override: [remotes.preview]");
      });
    },
  );

  it.effect("leaves a [remotes.*] block unselected when its project_id is not the target", () => {
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${FLAG_PROJECT_REF}"\n`,
      projectRef: VALID_REF,
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Loading config override");
    });
  });

  it.effect("pushes to the linked project and caches the project ref (json)", () => {
    const { layer, out, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      projectRef: VALID_REF,
      format: "json",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPush({ ...DEFAULT_FLAGS, remote: REMOTE_LINKED }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Confirmed by --yes: Apply 1 migration");
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(VALID_REF);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["migrations"]).toEqual(["20240101000000_test.sql"]);
    });
  });

  it.effect("--remote=<ref> drives which [remotes.<ref>] block merges into config", () => {
    // `[remotes.staging]`'s `project_id` matches the flag ref, not the resolver's own
    // `VALID_REF` fallback, so the override only announces if the flag resolved it.
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.staging]\nproject_id = "${FLAG_PROJECT_REF}"\n`,
    });
    return Effect.gen(function* () {
      yield* dbPush({
        ...DEFAULT_FLAGS,
        remote: Option.some({ _tag: "Ref", ref: FLAG_PROJECT_REF } as const),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Loading config override: [remotes.staging]");
    });
  });
});

const CONSENT_READS = new Set([LIST_MIGRATIONS, SELECT_SEEDS, READ_VAULT]);

describeHostedConsent("db push", {
  setup: (workdir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${workdir}/supabase/.temp`, { recursive: true });
      yield* fs.writeFileString(`${workdir}/supabase/.temp/project-ref`, VALID_REF);
      yield* fs.writeFileString(
        `${workdir}/supabase/config.toml`,
        'project_id = "test"\n\n[db.vault]\nexisting = "v1"\nfresh = "v2"\n',
      );
      yield* fs.makeDirectory(`${workdir}/${MIGRATION_DIR}`, { recursive: true });
      yield* fs.writeFileString(
        `${workdir}/${MIGRATION_DIR}/20240101000000_test.sql`,
        "create table t ();",
      );
      yield* fs.writeFileString(`${workdir}/supabase/roles.sql`, "create role app;");
      yield* fs.writeFileString(`${workdir}/supabase/seed.sql`, "insert into t values (1);");
    }),
  invoke: ({ out }) => {
    const conn = mockConnection({ vaultRows: [{ id: "id-1", name: "existing" }] });
    return {
      run: dbPush({
        ...DEFAULT_FLAGS,
        remote: REMOTE_LINKED,
        includeRoles: true,
        includeSeed: Option.some(true),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            conn.layer,
            mockResolver().layer,
            configValuesLayer({
              output: out.layer,
              flags: [flagInput("db.seed.enabled", "include-seed", true)],
            }),
            Layer.succeed(DnsResolverFlag, "native"),
          ),
        ),
      ),
      mutations: () =>
        conn.execs.length + conn.queries.filter((query) => !CONSENT_READS.has(query.sql)).length,
    };
  },
});
