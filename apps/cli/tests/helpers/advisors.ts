import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { cliConfigValuesTestLayer } from "./config-values-layer.ts";
import { branchRow } from "./remote-selection.ts";
import { mockOutput, mockProcessControl } from "./mocks.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  sequentialExecBatch,
} from "./command-mocks.ts";
import {
  projectResponse,
  realDbConfigResolver,
  realLinkedProjectCache,
} from "./permission-real-layers.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { DnsResolverFlag, OutputFlag, YesFlag } from "../../src/command-internal/global-flags.ts";
import { CommandCredentials } from "../../src/auth/command-credentials.service.ts";
import { InvalidAccessTokenError } from "../../src/auth/errors.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { DbConfigIpv6Error } from "../../src/command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../src/command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../src/command-internal/db-config.types.ts";
import { TargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import { DbExecError } from "../../src/command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type PgConnInput,
  type DbSession,
} from "../../src/command-internal/db-connection.service.ts";
import { splitLintsSql } from "../../src/command-internal/advisors/advisors.lints-sql.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

export const [SETUP_SQL, QUERY_SQL] = splitLintsSql();

export function lintRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: "rls_disabled_in_public",
    title: "RLS disabled in public",
    level: "ERROR",
    facing: "EXTERNAL",
    categories: ["SECURITY"],
    description: "Detects tables without RLS.",
    detail: "Table public.users has RLS disabled",
    remediation: "https://supabase.com/docs",
    metadata: { schema: "public", name: "users", type: "table" },
    cache_key: "rls_disabled_in_public_public_users",
    ...over,
  };
}

function mockResolver(opts: { ipv6Error?: boolean } = {}) {
  const resolveInputs: Array<DbConnectionInput> = [];
  const layer = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) =>
      Effect.gen(function* () {
        resolveInputs.push(input);
        if (opts.ipv6Error === true) {
          return yield* new DbConfigIpv6Error({
            message: "IPv6 is not supported on your current network",
            suggestion: "Run supabase link --project-ref abc to setup IPv4 connection.",
          });
        }
        return {
          conn: LOCAL_CONN,
          isLocal: input.target.kind !== "linked",
          ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
          target: input.target,
        } satisfies ResolvedDbConnection;
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return {
    layer,
    get resolveInputs() {
      return resolveInputs;
    },
  };
}

function mockConnection(opts: {
  rows?: ReadonlyArray<Record<string, unknown>>;
  setupFails?: boolean;
  exposureFails?: boolean;
  queryFails?: boolean;
}) {
  const execs: Array<string> = [];
  const calls: Array<{ kind: "exec" | "query"; sql: string; params?: ReadonlyArray<unknown> }> = [];
  const layer = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            calls.push({ kind: "exec", sql });
            if (sql === SETUP_SQL && opts.setupFails === true) {
              return Effect.fail(new DbExecError({ message: "syntax error at set" }));
            }
            return Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            calls.push({ kind: "query", sql, params });
            if (sql.includes("pgrst.db_schemas") && opts.exposureFails === true) {
              return Effect.fail(new DbExecError({ message: "permission denied" }));
            }
            if (sql === QUERY_SQL && opts.queryFails === true) {
              return Effect.fail(new DbExecError({ message: "syntax error" }));
            }
            return Effect.succeed(opts.rows ?? []);
          }),
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });
  return {
    layer,
    calls,
    get execs() {
      return execs;
    },
  };
}

function mockProjectRef() {
  const calls: Array<string> = [];
  const layer = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Effect.sync(() => {
        calls.push("resolveRef");
        return {
          ref: Option.getOrElse(flagValue, () => VALID_REF),
          source: Option.isSome(flagValue) ? ("flag" as const) : ("file" as const),
          matchesLinkedRef: Option.isNone(flagValue),
        };
      }),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

function mockCredentials(opts: { token?: "valid" | "none" | "invalid" } = {}) {
  const state = opts.token ?? "valid";
  const getAccessToken =
    state === "invalid"
      ? Effect.fail(
          new InvalidAccessTokenError({
            message: "Invalid access token format. Must be like `sbp_0102...1920`.",
          }),
        )
      : state === "none"
        ? Effect.sync(() => Option.none<Redacted.Redacted<string>>())
        : Effect.sync(() => Option.some(Redacted.make(VALID_TOKEN)));
  const layer = Layer.succeed(CommandCredentials, {
    getAccessToken,
    saveAccessToken: () => Effect.die("unexpected credentials write in advisors test"),
    deleteAccessToken: Effect.die("unexpected credentials delete in advisors test"),
    deleteAllProjectCredentials: Effect.die("unexpected project-credential sweep in advisors test"),
    deleteProjectCredential: () =>
      Effect.die("unexpected project-credential delete in advisors test"),
  });
  return { layer };
}

export interface AdvisorTestOptions {
  format?: "text" | "json" | "stream-json";
  rows?: ReadonlyArray<Record<string, unknown>>;
  setupFails?: boolean;
  exposureFails?: boolean;
  queryFails?: boolean;
  loggedIn?: boolean;
  invalidToken?: boolean;
  ipv6Error?: boolean;
  healthLints?: ReadonlyArray<Record<string, unknown>>;
  healthStatus?: number;
  securityStatus?: number;
  securityRawBody?: string;
  securityLints?: ReadonlyArray<Record<string, unknown>>;
  beforeResponse?: (url: string) => Effect.Effect<void>;
  performanceStatus?: number;
  performanceLints?: ReadonlyArray<Record<string, unknown>>;
  realLayers?: boolean;
  realEnv?: Readonly<Record<string, string>>;
}

export function setupAdvisors(workdir: string, opts: AdvisorTestOptions = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const resolver = mockResolver({ ipv6Error: opts.ipv6Error });
  const connection = mockConnection({
    rows: opts.rows,
    setupFails: opts.setupFails,
    exposureFails: opts.exposureFails,
    queryFails: opts.queryFails,
  });
  const telemetry = mockTelemetryStateTracked();
  const processControl = mockProcessControl();
  const projectRef = mockProjectRef();
  const cache = mockLinkedProjectCacheTracked();

  const api = mockCommandPlatformApi({
    handler: (request) =>
      Effect.gen(function* () {
        yield* opts.beforeResponse?.(request.url) ?? Effect.void;
        const url = request.url;
        if (url.includes("/advisors/run"))
          return yield* Effect.succeed(
            jsonResponse(request, opts.healthStatus ?? 200, {
              data: { type: "project_advisors", attributes: { lints: opts.healthLints ?? [] } },
            }),
          );
        if (url.includes("/advisors/security")) {
          const status = opts.securityStatus ?? 200;
          if (status !== 200) {
            return yield* Effect.succeed(jsonResponse(request, status, { message: "boom" }));
          }
          if (opts.securityRawBody !== undefined) {
            return yield* Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(opts.securityRawBody, {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }
          return yield* Effect.succeed(
            jsonResponse(request, 200, { lints: opts.securityLints ?? [] }),
          );
        }
        if (url.includes("/advisors/performance")) {
          return yield* Effect.succeed(
            jsonResponse(request, opts.performanceStatus ?? 200, {
              lints: opts.performanceLints ?? [],
            }),
          );
        }
        if (request.method === "GET" && url.endsWith(`/v1/projects/${VALID_REF}`)) {
          return yield* Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        if (request.method === "GET" && url.endsWith(`/v1/projects/${VALID_REF}/branches`)) {
          return yield* Effect.succeed(jsonResponse(request, 200, [branchRow("feature-x")]));
        }
        return jsonResponse(request, 404, {});
      }),
  });

  const cliSettings = mockCommandSettings({
    workdir: workdir,
    accessToken: opts.loggedIn === false ? Option.none() : undefined,
  });
  const credentials = mockCredentials({
    token: opts.invalidToken === true ? "invalid" : opts.loggedIn === false ? "none" : "valid",
  });

  const layer = Layer.mergeAll(
    out.layer,
    opts.realLayers !== true
      ? resolver.layer
      : realDbConfigResolver({
          workdir: workdir,
          dbConnection: connection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN, ...opts.realEnv },
        }),
    connection.layer,
    telemetry.layer,
    processControl.layer,
    projectRef.layer,
    opts.realLayers !== true
      ? cache.layer
      : realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    cliSettings,
    credentials.layer,
    api.factoryLayer,
    cliConfigValuesTestLayer,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    Layer.succeed(YesFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(CliArgs, { args: [] }),
    BunServices.layer,
  );
  return {
    layer,
    out,
    connection,
    telemetry,
    processControl,
    cache,
    api,
    projectRef,
    resolver,
  };
}
