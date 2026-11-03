import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
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
import { describeDbTargetSelection } from "../../../../tests/helpers/db-target-selection.ts";
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
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { HostedMutationDeclinedError } from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { TargetPasswordConflictError } from "../../../command-internal/target/target.errors.ts";
import { MigrationFileNotFoundError, MigrationInvalidVersionError } from "../migration.errors.ts";
import { MigrationRepairUpdateError } from "./repair.errors.ts";
import { migrationRepair, type MigrationRepairInput } from "./repair.handler.ts";
import { branchRow } from "../../../../tests/helpers/remote-selection.ts";

const FLAG_REF = "flagflagflagflagflag";

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly failSql?: string;
  readonly failResolve?: boolean;
  readonly args?: ReadonlyArray<string>;
}

function fakeDatabase(opts: Pick<SetupOpts, "failSql"> = {}) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];

  const resolverCalls: Array<DbConnectionInput> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (connectionInput: DbConnectionInput) => {
      resolverCalls.push(connectionInput);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: connectionInput.target.kind === "local",
        ref:
          connectionInput.target.kind === "linked"
            ? Option.some(connectionInput.target.ref)
            : Option.none(),
        target: connectionInput.target,
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
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new DbExecError({ message: "boom" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new DbExecError({ message: "boom" }))
              : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
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
  const interactive = opts.interactive ?? false;
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive,
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const { resolver, connection, execs, queries, resolverCalls } = fakeDatabase(opts);

  // Gives an explicit --project-ref flag precedence over the VALID_REF fallback, so a
  // test can prove the flag drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      opts.failResolve === true
        ? Effect.fail(
            new ProjectRefNotLinkedError({
              message: "Cannot find project ref. Have you run link?",
            }),
          )
        : Effect.succeed({
            ref: Option.getOrElse(flagValue, () => VALID_REF),
            source: Option.isSome(flagValue) ? ("flag" as const) : ("file" as const),
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
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    commandRuntimeLayer(["migration", "repair"]).pipe(Layer.provide(BunServices.layer)),
    mockTty({ stdinIsTty: interactive, stdoutIsTty: interactive }),
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
  };
}

const input = (over: Partial<MigrationRepairInput> = {}): MigrationRepairInput => ({
  versions: over.versions ?? [],
  status: over.status ?? "applied",
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const seedMigration = Effect.fnUntraced(function* (workdir: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${workdir}/supabase/migrations`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${dir}/${name}`, body);
});

const tmp = useTempWorkdir();

describe("migration repair", () => {
  it.effect("marks a version as applied by upserting from its local file", () => {
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      expect(execs).toContain("BEGIN");
      expect(execs).toContain("COMMIT");
      expect(execs).not.toContain("ROLLBACK");
      const upsert = queries.find((q) => q.sql.includes("ON CONFLICT"));
      expect(upsert?.params).toEqual(["20240101000000", "init", ["create table a"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the DB target before parsing positional versions", () => {
    const { layer } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({
          versions: ["not-a-number"],
          status: "applied",
          remote: Option.some({ _tag: "Linked" }),
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches the linked project even when the consent is declined", () => {
    const { layer, cache } = setup(tmp.current, { interactive: true, confirm: false });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      const error = yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          remote: Option.some({ _tag: "Linked" }),
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(HostedMutationDeclinedError);
      expect(cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks versions as reverted by deleting them", () => {
    const { layer, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "reverted" }),
      );
      const del = queries.find((q) => q.sql.includes("WHERE version = ANY"));
      expect(del?.params).toEqual([["20240101000000", "20240102000000"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a non-numeric version", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationInvalidVersionError);
      // Unlike db reset's bare message, migration repair keeps the "failed to parse <v>:" wrapper.
      expect(error.message).toBe("failed to parse not-a-number: invalid version number");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a version outside the int range before any DB mutation", () => {
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["99999999999999999999"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationInvalidVersionError);
      expect(execs).not.toContain("BEGIN");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "repair-all truncates and reapplies local files on the local database without prompting",
    () => {
      const { layer, execs, queries, out } = setup(tmp.current);
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
        yield* migrationRepair(input({ versions: [], status: "applied" }));
        expect(out.promptConfirmCalls).toEqual([]);
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "repair-all with --status reverted wipes the whole history (no upserts, no deletes)",
    () => {
      // repair-all + reverted only queues TRUNCATE; DELETE is the non-repair-all path
      // and UPSERT is the applied path.
      const { layer, execs, queries } = setup(tmp.current);
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
        yield* migrationRepair(input({ versions: [], status: "reverted" }));
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
        expect(queries.some((q) => q.sql.includes("WHERE version = ANY"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("repair-all on a linked project is declined at the consent and changes nothing", () => {
    const { layer, execs } = setup(tmp.current, { interactive: true, confirm: false });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      const error = yield* migrationRepair(
        input({ versions: [], status: "applied", remote: Option.some({ _tag: "Linked" }) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(HostedMutationDeclinedError);
      expect(execs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a DB-config error before prompting (repair-all, unlinked)", () => {
    const { layer, out } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: [], status: "applied", remote: Option.some({ _tag: "Linked" }) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints the repaired, finished, and suggestion lines on success", () => {
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      const stderr = stripAnsi(out.stderrText);
      const stdout = stripAnsi(out.stdoutText);
      expect(stderr).toContain("Repaired migration history: [20240101000000] => applied");
      expect(stdout).toContain("Finished supabase migration repair.");
      expect(stderr).toContain(
        "Run supabase migration list to show the updated migration history.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests listing the history of the hosted project it repaired", () => {
    const ctx = setup(tmp.current, { yes: true });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          remote: Option.some({ _tag: "Ref", ref: FLAG_REF }),
        }),
      );
      expect(stripAnsi(ctx.out.stderrText)).toContain(
        `Run supabase migration list --remote=${FLAG_REF} to show the updated migration history.`,
      );
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("prints multiple repaired versions using the `[a b]` slice format", () => {
    // The established format is space-separated and bracketed, with no commas; a
    // `.join(", ")` cleanup would silently change established output.
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* seedMigration(tmp.current, "20240102000000_more.sql", "create table b;\n");
      yield* migrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "applied" }),
      );
      expect(stripAnsi(out.stderrText)).toContain(
        "Repaired migration history: [20240101000000 20240102000000] => applied",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a missing local file in applied mode before writing anything", () => {
    const { layer, execs } = setup(tmp.current); // no seeded file
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationFileNotFoundError);
      expect(execs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rolls back and reports an update failure", () => {
    const { layer, execs } = setup(tmp.current, { failSql: "WHERE version = ANY" });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "reverted" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationRepairUpdateError);
      expect(execs).toContain("ROLLBACK");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured result in json mode", () => {
    const { layer, out } = setup(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "reverted" }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history repaired",
          data: { versions: ["20240101000000"], status: "reverted", repairAll: false },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, { realLayers: true, yes: true });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
        }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration repair",
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

  it.effect(
    "makes no Management API request for the default local target through the real resolver",
    () => {
      const ctx = setup(tmp.current, { realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, () => undefined);
        yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
        yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
        expect(requests).toEqual([]);
        expect(ctx.http.calls).toEqual([]);
        assertPermissionDrift({
          command: "migration repair",
          activeFlags: {},
          requests: [],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(ctx.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect("rejects --password combined with --remote=<url> through the real resolver", () => {
    const ctx = setup(tmp.current, { realLayers: true });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      const error = yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          remote: Option.some({ _tag: "DbUrl", url: "postgresql://x" }),
          password: Option.some("pw"),
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetPasswordConflictError);
      expect(ctx.execs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ctx.layer));
  });

  it.effect("fetches the pooler config but mints no login role when --password is given", () => {
    const ctx = setup(tmp.current, { realLayers: true, yes: true });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          password: Option.some("pw"),
          remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
        }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
      ]);
      assertPermissionDrift({
        command: "migration repair",
        activeFlags: { password: true, remote: VALID_REF },
        requests: [...asRecordedRequests(requests), ...ctx.http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});

describeDbTargetSelection("migration repair", {
  dbUrl: true,
  workdir: () => tmp.current,
  attempt: ({ workdir, args, target }) => {
    const ctx = setup(workdir, { yes: true, args });
    return {
      layer: ctx.layer,
      out: ctx.out,
      run: seedMigration(workdir, "20240101000000_init.sql", "create table a;\n").pipe(
        Effect.andThen(
          migrationRepair(input({ versions: ["20240101000000"], status: "applied", ...target })),
        ),
      ),
      target: () => ctx.resolverCalls[0]?.target,
      cachedRef: () => ctx.cache.cachedRef,
      branchLookups: () => ctx.branchRequests,
      apiRequests: () => ctx.branchRequests,
    };
  },
});

describeHostedConsent("migration repair", {
  setup: (workdir) => seedMigration(workdir, "20240101000000_init.sql", "create table a;\n"),
  invoke: () => {
    const db = fakeDatabase();
    return {
      run: migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          remote: Option.some({ _tag: "Linked" }),
        }),
      ).pipe(
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
      mutations: () => db.execs.length,
    };
  },
});
