import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import type * as HttpClient from "effect/http/HttpClient";

import { dbConfigLayer } from "../../src/command-internal/db-config.layer.ts";
import type { DbConfigResolver } from "../../src/command-internal/db-config.service.ts";
import type { DbConnection } from "../../src/command-internal/db-connection.service.ts";
import { DebugLogger } from "../../src/command-internal/debug-logger.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
} from "../../src/command-internal/global-flags.ts";
import { identityStitchLayer } from "../../src/command-internal/identity-stitch.ts";
import type { CommandSettings } from "../../src/config/command-settings.service.ts";
import { linkedProjectCacheLayer } from "../../src/telemetry/linked-project-cache.layer.ts";
import type { LinkedProjectCache } from "../../src/telemetry/linked-project-cache.service.ts";
import { mockCommandCredentialsLayer, mockCommandSettings } from "./command-mocks.ts";
import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "./mocks.ts";

/**
 * The real `LinkedProjectCache`, so a command test records the `GET /v1/projects/{ref}` the
 * cache fill makes and the command's declaration is checked against it.
 */
export function realLinkedProjectCache(opts: {
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
  readonly cliSettings: Layer.Layer<CommandSettings>;
}): Layer.Layer<LinkedProjectCache> {
  const analytics = mockAnalytics();
  const identityStitch = identityStitchLayer.pipe(
    Layer.provide(analytics.layer),
    Layer.provide(mockTelemetryRuntime()),
    Layer.provide(BunServices.layer),
  );
  return linkedProjectCacheLayer.pipe(
    Layer.provide(opts.httpClient),
    Layer.provide(opts.cliSettings),
    Layer.provide(mockCommandCredentialsLayer),
    Layer.provide(identityStitch),
    Layer.provide(analytics.layer),
    Layer.provide(BunServices.layer),
  );
}

/**
 * The real `DbConfigResolver` on the linked path: the direct host (`db.<ref>.invalid`) is
 * unreachable once the test file mocks `node:net` to refuse it, so the resolver falls back to
 * the pooler and mints a login role through {@link stubManagementApi}. Provide the same `env`
 * to the running effect as a `ConfigProvider`, since the resolver reads it when it resolves.
 */
export function realDbConfigResolver(opts: {
  readonly workdir: string;
  readonly dbConnection: Layer.Layer<DbConnection>;
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<DbConfigResolver> {
  const deps = Layer.mergeAll(
    mockCommandSettings({
      workdir: opts.workdir,
      projectHost: "invalid",
      projectId: Option.none(),
    }),
    opts.dbConnection,
    Layer.succeed(DebugLogger, { debug: () => Effect.void, http: () => Effect.void }),
    mockOutput().layer,
    mockAnalytics().layer,
    mockTelemetryRuntime(),
    mockTty(),
    mockRuntimeInfo(),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.some(opts.workdir)),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    identityStitchLayer.pipe(
      Layer.provide(mockAnalytics().layer),
      Layer.provide(mockTelemetryRuntime()),
      Layer.provide(BunServices.layer),
    ),
    BunServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(opts.env, { preserveEmptyStrings: true })),
  );
  return dbConfigLayer.pipe(Layer.provide(deps));
}

/**
 * Replaces the global `fetch` for the scope, recording each Management API request the resolver's
 * own client makes. `respond` returns a `Response` for the routes a test serves; any other
 * request gets a 404.
 */
export const stubManagementApi = (
  requests: Array<{ readonly method: string; readonly path: string }>,
  respond: (method: string, path: string) => Response | undefined,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });
          return Promise.resolve(
            respond(method, url.pathname) ??
              Response.json({ message: "unexpected request" }, { status: 404 }),
          );
        },
        { preconnect: previousFetch.preconnect },
      );
      return previousFetch;
    }),
    (previousFetch) =>
      Effect.sync(() => {
        globalThis.fetch = previousFetch;
      }),
  );

/** A PRIMARY transaction pooler config for `ref`, as `GET /v1/projects/{ref}/config/database/pooler` returns it. */
export const primaryPoolerConfigs = (ref: string) => [
  {
    identifier: "primary",
    database_type: "PRIMARY",
    is_using_scram_auth: true,
    db_user: "postgres",
    db_host: "db.example",
    db_port: 5432,
    db_name: "postgres",
    connection_string: `postgres://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    connectionString: `postgres://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    default_pool_size: null,
    max_client_conn: null,
    pool_mode: "transaction",
  },
];
