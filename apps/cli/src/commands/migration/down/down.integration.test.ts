import { createHash } from "node:crypto";
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
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { MigrationDropError } from "../../../command-internal/drop-objects.ts";
import { MigrationSeedError } from "../../../command-internal/seed.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { MigrationLastTooLargeError, MigrationLastZeroError } from "./down.errors.ts";
import { migrationDown } from "./down.handler.ts";
import type { MigrationDownFlags } from "./down.command.ts";
import { branchRow } from "../../../../tests/helpers/remote-selection.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly yes?: boolean;
  readonly interactive?: boolean;
  readonly confirm?: boolean;
  readonly remote?: ReadonlyArray<string>;
  readonly failResolve?: boolean;
  readonly failDrop?: boolean;
  readonly failSeed?: boolean;
  readonly seedTable?: ReadonlyArray<{ path: string; hash: string }>;
  readonly args?: ReadonlyArray<string>;
}

const SELECT_SEED = "SELECT path, hash FROM supabase_migrations.seed_files";

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
            if (opts.failDrop === true && sql.startsWith("do $$")) {
              return Effect.fail(new DbExecError({ message: "permission denied" }));
            }
            if (opts.failSeed === true && sql.startsWith("insert into")) {
              return Effect.fail(new DbExecError({ message: "boom" }));
            }
            return Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            if (sql === LIST_SQL)
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            if (sql === SELECT_SEED) return Effect.succeed([...(opts.seedTable ?? [])]);
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

const droppedSchemas = (execs: ReadonlyArray<string>) =>
  execs.filter((sql) => sql.startsWith("do $$")).length;

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
    commandRuntimeLayer(["migration", "down"]).pipe(Layer.provide(BunServices.layer)),
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

const flags = (over: Partial<MigrationDownFlags> = {}): MigrationDownFlags => ({
  last: over.last ?? 1,
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

const tmp = useTempWorkdir();

describe("migration down", () => {
  it.effect("rejects --last 0", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationDown(flags({ last: 0 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationLastZeroError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the DB target before rejecting --last 0", () => {
    const { layer } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const error = yield* migrationDown(
        flags({ last: 0, remote: Option.some({ _tag: "Linked" }) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --last >= total applied migrations", () => {
    const { layer } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationLastTooLargeError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests the db reset of the same hosted target when --last is too large", () => {
    const { layer } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      const suggestionOf = (error: unknown) =>
        error instanceof MigrationLastTooLargeError ? stripAnsi(error.suggestion) : undefined;
      const local = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      const hosted = yield* migrationDown(
        flags({ last: 1, remote: Option.some({ _tag: "Linked" }) }),
      ).pipe(Effect.flip);
      expect(suggestionOf(local)).toBe(
        "Try supabase db reset if you want to revert all migrations.",
      );
      expect(suggestionOf(hosted)).toBe(
        "Try supabase db reset --remote if you want to revert all migrations.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reverts the local database to the target version without prompting", () => {
    const { layer, out, execs, queries } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Resetting database to version: 20240101000000");
      expect(out.promptConfirmCalls).toEqual([]);
      expect(droppedSchemas(execs)).toBe(1);
      expect(
        queries.some(
          (q) =>
            q.sql.includes("INSERT INTO supabase_migrations") && q.params?.[0] === "20240101000000",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reverts a linked project after the user accepts the listed migrations", () => {
    const { layer, out, execs, cache } = setup(tmp.current, {
      interactive: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1, remote: Option.some({ _tag: "Linked" }) }));
      const stderr = stripAnsi(out.stderrText);
      expect(stderr).toContain("20240102000000");
      expect(stderr).toContain("you will lose all data in this database");
      expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
      expect(droppedSchemas(execs)).toBe(1);
      expect(cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured result in json on the local database", () => {
    const { layer, out } = setup(tmp.current, {
      format: "json",
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1 }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migrations reverted",
          data: { version: "20240101000000", last: 1 },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a drop-schema failure", () => {
    const { layer } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
      failDrop: true,
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationDropError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("seeds data from a new seed file and records its hash", () => {
    const { layer, out, queries } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", "insert into a values (1);\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Seeding data from supabase/seed.sql...");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a seed-apply failure", () => {
    const { layer } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
      failSeed: true,
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", "insert into a values (1);\n");
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationSeedError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips an unchanged seed file", () => {
    const body = "insert into a values (1);\n";
    const hash = createHash("sha256").update(body).digest("hex");
    const { layer, out, queries } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
      seedTable: [{ path: "supabase/seed.sql", hash }],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", body);
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).not.toContain("Seeding data from");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("updates the recorded hash (without re-running) for a changed seed file", () => {
    const { layer, out, execs, queries } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
      seedTable: [{ path: "supabase/seed.sql", hash: "stale-hash-does-not-match" }],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", "insert into a values (2);\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Updating seed hash to supabase/seed.sql...");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
      expect(execs).not.toContain("insert into a values (2)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips migration apply when db.migrations.enabled = false", () => {
    const { layer, queries } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "config.toml", "[db.migrations]\nenabled = false\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, {
      yes: true,
      realLayers: true,
      remote: ["20240101000000", "20240102000000"],
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(
        flags({ last: 1, remote: Option.some({ _tag: "Ref", ref: VALID_REF }) }),
      );
      expect(ctx.out.stderrText).toContain("Resetting database to version: 20240101000000");
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration down",
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
    const ctx = setup(tmp.current, {
      realLayers: true,
      remote: ["20240101000000", "20240102000000"],
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1 }));
      expect(ctx.out.stderrText).toContain("Resetting database to version: 20240101000000");
      expect(requests).toEqual([]);
      expect(ctx.http.calls).toEqual([]);
      assertPermissionDrift({
        command: "migration down",
        requests: [],
        exact: true,
      });
      expect(() =>
        assertPermissionDrift({
          command: "migration down",
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

describeDbTargetSelection("migration down", {
  dbUrl: true,
  workdir: () => tmp.current,
  attempt: ({ workdir, args, target }) => {
    const ctx = setup(workdir, { yes: true, remote: ["20240101000000", "20240102000000"], args });
    return {
      layer: ctx.layer,
      out: ctx.out,
      run: seed(workdir, "20240101000000_a.sql").pipe(
        Effect.andThen(migrationDown(flags({ last: 1, ...target }))),
      ),
      target: () => ctx.resolverCalls[0]?.target,
      cachedRef: () => ctx.cache.cachedRef,
      branchLookups: () => ctx.branchRequests,
    };
  },
});

describeHostedConsent("migration down", {
  setup: (workdir) => seed(workdir, "20240101000000_a.sql"),
  invoke: () => {
    const db = fakeDatabase({ remote: ["20240101000000", "20240102000000"] });
    return {
      run: migrationDown(flags({ last: 1, remote: Option.some({ _tag: "Linked" }) })).pipe(
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
      mutations: () => droppedSchemas(db.execs),
    };
  },
});
