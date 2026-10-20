import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
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
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { DnsResolverFlag, OutputFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { MigrationApplyError } from "../../../command-internal/migration-apply.ts";
import { MigrationVaultError } from "../../../command-internal/vault.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import {
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { MigrationMissingLocalError, MigrationMissingRemoteError } from "./up.errors.ts";
import { migrationUp } from "./up.handler.ts";
import type { MigrationUpFlags } from "./up.command.ts";
import {
  BRANCH_PROJECT_REF,
  branchRow,
  warningsOf,
} from "../../../../tests/helpers/remote-selection.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const READ_VAULT = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";
const FLAG_REF = "flagflagflagflagflag";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly yes?: boolean;
  readonly remote?: ReadonlyArray<string>;
  readonly failApply?: boolean;
  readonly failVault?: boolean;
  readonly existingVault?: ReadonlyArray<{ id: string; name: string }>;
  readonly args?: ReadonlyArray<string>;
}

function fakeDatabase(opts: SetupOpts = {}) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];

  const resolverCalls: Array<DbConnectionInput> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      resolverCalls.push(input);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: input.target.kind === "local",
        ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            return opts.failApply === true && sql.startsWith("create table boom")
              ? Effect.fail(new DbExecError({ message: "syntax error" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            if (opts.failVault === true && sql === READ_VAULT)
              return Effect.fail(new DbExecError({ message: "boom" }));
            if (sql === LIST_SQL)
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            if (sql === READ_VAULT)
              return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([
                ...(opts.existingVault ?? []),
              ]);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // Replays each statement through exec/query so recordings and failure injection apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });
  return { resolver, connection, execs, queries, resolverCalls };
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const { resolver, connection, execs, queries, resolverCalls } = fakeDatabase(opts);

  // The flag value takes precedence over the VALID_REF fallback, so tests can assert the
  // flag drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Effect.succeed({
        ref: Option.getOrElse(flagValue, () => VALID_REF),
        source: Option.isSome(flagValue) ? "flag" : "file",
        matchesLinkedRef: Option.isNone(flagValue),
      }),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const http = recordingProjectHttpClient(VALID_REF);
  const branchApi = mockCommandPlatformApi({
    handler: (request) => Effect.succeed(jsonResponse(request, 200, [branchRow("feature-x")])),
  });
  const layer = Layer.mergeAll(
    cliConfigValuesTestLayer,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(OutputFlag, Option.none()),
    mockTty(),
    out.layer,
    telemetry.layer,
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: http.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : cache.layer,
    opts.realLayers === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: connection,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : resolver,
    connection,
    projectRef,
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    commandRuntimeLayer(["migration", "up"]).pipe(Layer.provide(BunServices.layer)),
    branchApi.layer,
    BunServices.layer,
  );
  return {
    layer,
    http,
    out,
    telemetry,
    execs,
    queries,
    cache,
    resolverCalls,
    branchRequests: branchApi.requests,
    warnings: () => warningsOf(out),
  };
}

const flags = (over: Partial<MigrationUpFlags> = {}): MigrationUpFlags => ({
  includeAll: over.includeAll ?? false,
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
});

const seed = Effect.fnUntraced(function* (
  workdir: string,
  name: string,
  body = "create table a;\n",
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${workdir}/supabase/migrations`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${dir}/${name}`, body);
});

const writeProjectFile = Effect.fnUntraced(function* (workdir: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), body);
});
const insertedVersions = (queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }>) =>
  queries
    .filter((q) => q.sql.includes("INSERT INTO supabase_migrations"))
    .map((q) => q.params?.[0]);

const tmp = useTempWorkdir();

describe("migration up", () => {
  it.effect("applies pending migrations in order and prints progress", () => {
    const { layer, out, queries } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* seed(tmp.current, "20240102000000_b.sql");
      yield* seed(tmp.current, "20240103000000_c.sql");
      yield* migrationUp(flags());
      const stderr = stripAnsi(out.stderrText);
      const stdout = stripAnsi(out.stdoutText);
      expect(stderr).toContain("Applying migration 20240102000000_b.sql...");
      expect(stderr).toContain("Applying migration 20240103000000_c.sql...");
      expect(stdout).toContain("Local database is up to date.");
      expect(stdout).not.toContain("Applying migration");
      expect(stderr).not.toContain("Local database is up to date.");
      expect(insertedVersions(queries)).toEqual(["20240102000000", "20240103000000"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("errors with a revert suggestion when a remote version is missing locally", () => {
    const { layer } = setup(tmp.current, { remote: ["20240101000000", "20240199000000"] });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      const error = yield* migrationUp(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationMissingLocalError);
      expect(error).toMatchObject({
        suggestion: expect.stringContaining("migration repair --status reverted 20240199000000\n"),
      });
      expect(error).toMatchObject({
        suggestion: expect.stringContaining("supabase db pull\n"),
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("errors with an --include-all suggestion on an out-of-order local migration", () => {
    const { layer } = setup(tmp.current, { remote: ["20240102000000"] });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* seed(tmp.current, "20240102000000_b.sql");
      const error = yield* migrationUp(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationMissingRemoteError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies out-of-order migrations with --include-all in the right order", () => {
    const { layer, queries } = setup(tmp.current, { remote: ["20240102000000"] });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql"); // out-of-order (before applied 02)
      yield* seed(tmp.current, "20240102000000_b.sql"); // already applied on remote
      yield* seed(tmp.current, "20240103000000_c.sql"); // trailing pending
      yield* migrationUp(flags({ includeAll: true }));
      expect(insertedVersions(queries)).toEqual(["20240101000000", "20240103000000"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a new [db.vault] secret before applying migrations", () => {
    const { layer, out, queries } = setup(tmp.current, {
      remote: [],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "config.toml", '[db.vault]\nmy_secret = "shhh"\n');
      yield* migrationUp(flags());
      expect(stripAnsi(out.stderrText)).toContain("Updating vault secrets...");
      const create = queries.find((q) => q.sql.includes("create_secret"));
      expect(create?.params).toEqual(["shhh", "my_secret"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a vault upsert failure", () => {
    const { layer } = setup(tmp.current, {
      remote: [],
      failVault: true,
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "config.toml", '[db.vault]\nmy_secret = "shhh"\n');
      const error = yield* migrationUp(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationVaultError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("updates an existing [db.vault] secret by id", () => {
    const { layer, queries } = setup(tmp.current, {
      remote: [],
      existingVault: [{ id: "vault-id-1", name: "my_secret" }],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "config.toml", '[db.vault]\nmy_secret = "shhh"\n');
      yield* migrationUp(flags());
      const update = queries.find((q) => q.sql.includes("update_secret"));
      expect(update?.params).toEqual(["vault-id-1", "shhh"]);
      expect(queries.some((q) => q.sql.includes("create_secret"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --remote combined with --local", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationUp(
        flags({ remote: Option.some({ _tag: "Linked" }), local: true }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetSelectorConflictError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies on the project given via --remote=<ref>", () => {
    // VALID_REF is the resolver's fallback if the flag were absent; the flag must win.
    const ctx = setup(tmp.current, { yes: true, remote: [] });
    return Effect.gen(function* () {
      yield* migrationUp(flags({ remote: Option.some({ _tag: "Ref", ref: FLAG_REF }) }));
      expect(ctx.resolverCalls[0]?.target).toMatchObject({ kind: "linked", ref: FLAG_REF });
      expect(ctx.cache.cachedRef).toBe(FLAG_REF);
      expect(ctx.cache.cachedRef).not.toBe(VALID_REF);
      expect(ctx.warnings()).toEqual([]);
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("applies on the project of the branch --remote=<branch> names", () => {
    const ctx = setup(tmp.current, { yes: true, remote: [] });
    return Effect.gen(function* () {
      yield* migrationUp(flags({ remote: Option.some({ _tag: "Branch", name: "feature-x" }) }));
      expect(ctx.branchRequests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/branches`,
      ]);
      expect(ctx.resolverCalls[0]?.target).toMatchObject({
        kind: "linked",
        ref: BRANCH_PROJECT_REF,
      });
      expect(ctx.cache.cachedRef).toBe(BRANCH_PROJECT_REF);
      expect(ctx.warnings()).toEqual([]);
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("fails with the branches that exist when --remote=<branch> matches none", () => {
    const ctx = setup(tmp.current, { yes: true, remote: [] });
    return Effect.gen(function* () {
      const error = yield* migrationUp(
        flags({ remote: Option.some({ _tag: "Branch", name: "feature-y" }) }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "LinkBranchNotFoundError",
        message: expect.stringContaining("Available branches: feature-x"),
      });
      expect(ctx.resolverCalls).toEqual([]);
      expect(ctx.execs).toEqual([]);
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect(
    "applies on the database --remote=<url> names and never touches the linked cache",
    () => {
      const ctx = setup(tmp.current, { yes: true, remote: [] });
      return Effect.gen(function* () {
        yield* seed(tmp.current, "20240101000000_a.sql");
        yield* migrationUp(flags({ remote: Option.some({ _tag: "DbUrl", url: DB_URL }) }));
        expect(ctx.resolverCalls[0]?.target).toMatchObject({ kind: "db-url" });
        expect(insertedVersions(ctx.queries)).toEqual(["20240101000000"]);
        expect(ctx.cache.cached).toBe(false);
        expect(ctx.warnings()).toEqual([]);
      }).pipe(Effect.provide(ctx.layer));
    },
  );

  describe("deprecated selectors", () => {
    const cases = [
      {
        alias: "--linked",
        args: ["migration", "up", "--linked"],
        flags: { linked: true },
        target: { kind: "linked", ref: VALID_REF },
        warning: "--linked is deprecated and will be removed in v4. Use --remote instead",
      },
      {
        alias: "--project-ref",
        args: ["migration", "up", "--project-ref", FLAG_REF],
        flags: { projectRef: Option.some(FLAG_REF) },
        target: { kind: "linked", ref: FLAG_REF },
        warning: `--project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead`,
      },
      {
        alias: "--db-url",
        args: ["migration", "up", "--db-url", DB_URL],
        flags: { dbUrl: Option.some(DB_URL) },
        target: { kind: "db-url" },
        warning: "--db-url is deprecated and will be removed in v4. Use --remote=<db-url> instead",
      },
      {
        alias: "--local",
        args: ["migration", "up", "--local"],
        flags: { local: true },
        target: { kind: "local" },
        warning: "--local isn't needed (local is the default) and will be removed in v4",
      },
    ] as const satisfies ReadonlyArray<{
      readonly alias: string;
      readonly args: ReadonlyArray<string>;
      readonly flags: Partial<MigrationUpFlags>;
      readonly target: Record<string, string>;
      readonly warning: string;
    }>;

    for (const testCase of cases) {
      it.effect(`${testCase.alias} still selects its target and warns`, () => {
        const ctx = setup(tmp.current, { yes: true, remote: [], args: testCase.args });
        return Effect.gen(function* () {
          yield* migrationUp(flags(testCase.flags));
          expect(ctx.resolverCalls[0]?.target).toMatchObject(testCase.target);
          expect(ctx.warnings()).toEqual([testCase.warning]);
        }).pipe(Effect.provide(ctx.layer));
      });
    }

    it.effect("rejects --project-ref combined with --local before touching the database", () => {
      const { layer, execs, queries, cache } = setup(tmp.current, { remote: [] });
      return Effect.gen(function* () {
        const error = yield* migrationUp(
          flags({ local: true, projectRef: Option.some(FLAG_REF) }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(TargetProjectRefConflictError);
        expect(execs).toEqual([]);
        expect(queries).toEqual([]);
        expect(cache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  });

  it.effect(
    "applies nothing and asks for no consent on a linked project that is up to date",
    () => {
      const { layer, out, queries } = setup(tmp.current, {
        format: "json",
        remote: ["20240101000000"],
      });
      return Effect.gen(function* () {
        yield* seed(tmp.current, "20240101000000_a.sql");
        yield* migrationUp(flags({ remote: Option.some({ _tag: "Linked" }) }));
        expect(insertedVersions(queries)).toEqual([]);
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "success", message: "Migrations applied" }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("reports a remote database as up to date for a linked target", () => {
    const { layer, out } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationUp(flags({ remote: Option.some({ _tag: "Linked" }) }));
      expect(stripAnsi(out.stdoutText)).toContain("Remote database is up to date.");
      expect(stripAnsi(out.stdoutText)).not.toContain("Local database is up to date.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured result in json", () => {
    const { layer, out } = setup(tmp.current, { format: "json", remote: [] });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationUp(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Migrations applied" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces an apply failure", () => {
    const { layer } = setup(tmp.current, { remote: [], failApply: true });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql", "create table boom;\n");
      const error = yield* migrationUp(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationApplyError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, { realLayers: true, remote: [], yes: true });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationUp(flags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF }) }));
      expect(insertedVersions(ctx.queries)).toEqual(["20240101000000"]);
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration up",
        activeFlags: { remote: VALID_REF },
        requests: [...asRecordedRequests(requests), ...ctx.http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("defaults to the local target and makes no Management API request", () => {
    const ctx = setup(tmp.current, { realLayers: true, remote: [] });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationUp(flags());
      expect(insertedVersions(ctx.queries)).toEqual(["20240101000000"]);
      expect(requests).toEqual([]);
      expect(ctx.http.calls).toEqual([]);
      assertPermissionDrift({
        command: "migration up",
        requests: [],
        exact: true,
      });
      expect(() =>
        assertPermissionDrift({
          command: "migration up",
          requests: [
            {
              method: "POST",
              url: `https://api.supabase.com/v1/projects/${VALID_REF}/cli/login-role`,
            },
          ],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});

describeHostedConsent("migration up", {
  setup: (workdir) => seed(workdir, "20240101000000_a.sql"),
  invoke: () => {
    const db = fakeDatabase({ remote: [] });
    return {
      run: migrationUp(flags({ remote: Option.some({ _tag: "Linked" }) })).pipe(
        Effect.provide(
          Layer.mergeAll(
            db.resolver,
            db.connection,
            cliConfigValuesTestLayer,
            mockTelemetryStateTracked().layer,
            Layer.succeed(DnsResolverFlag, "native"),
          ),
        ),
      ),
      mutations: () => insertedVersions(db.queries).length,
    };
  },
});
