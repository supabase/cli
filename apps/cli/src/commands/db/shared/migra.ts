import { Effect, Option } from "effect";

import { NetworkIdFlag } from "../../../command-internal/global-flags.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  DbConnection,
  type DbConnectOptions,
} from "../../../command-internal/db-connection.service.ts";
import { parseConnectionString } from "../../../command-internal/db-config.parse.ts";
import { getRegistryImageUrl } from "../../../command-internal/docker-registry.ts";
import { DockerRun } from "../../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScript } from "../../../command-internal/edge-runtime-script.service.ts";
import { PG_DELTA_CA_BUNDLE } from "../../../command-internal/pgdelta-ssl.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import { migraDiffScript, migraDiffShellScript } from "./migra.deno-templates.ts";
import { MigraDiffError, MigraSchemaLoadError } from "./migra.errors.ts";
import { edgeRuntimeId, type PgDeltaContext } from "../../../command-internal/pgdelta.ts";

/**
 * The migra Docker image, used only by the OOM bash fallback; the common edge-runtime path
 * runs `@pgkit/migra` instead.
 */
const MIGRA_IMAGE = "supabase/migra:3.0.1663481299";

/**
 * Schemas excluded from a no-`--schema` migra diff: local-dev, extension-owned,
 * deprecated-extension, and Supabase-managed schemas. Passed as `EXCLUDED_SCHEMAS` to the
 * edge-runtime template.
 */
const MIGRA_MANAGED_SCHEMAS: ReadonlyArray<string> = [
  // Local development
  "_analytics",
  "_realtime",
  "_supavisor",
  // Owned by extensions
  "cron",
  "graphql",
  "graphql_public",
  "net",
  "pgroonga",
  "pgtle",
  "repack",
  "tiger_data",
  "vault",
  // Deprecated extensions
  "pgsodium",
  "pgsodium_masks",
  "timescaledb_experimental",
  "timescaledb_information",
  "_timescaledb_cache",
  "_timescaledb_catalog",
  "_timescaledb_config",
  "_timescaledb_debug",
  "_timescaledb_functions",
  "_timescaledb_internal",
  // Managed by Supabase
  "pgbouncer",
  "supabase_functions",
  "supabase_migrations",
];

/** LIKE patterns excluded when resolving the migra bash fallback's schema list. */
const LIST_SCHEMAS_EXCLUDE: ReadonlyArray<string> = [
  "information\\_schema",
  "pg\\_%",
  "\\_analytics",
  "\\_realtime",
  "\\_supavisor",
  "pgbouncer",
  "pgmq",
  "pgsodium",
  "pgtle",
  "supabase\\_migrations",
  "vault",
];

/**
 * Lists user-defined schemas, excluding extension-created ones (the `pg_depend` anti-join is
 * scoped to `pg_namespace` via `classid` so an oid collision in another catalog can't hide a
 * schema — see supabase/cli#6375), Supabase-managed names, and schemas owned by `supabase_admin`.
 */
export const listSchemasSql = `-- List user defined schemas, excluding
--  Extension created schemas
--  Supabase managed schemas
select pn.nspname
from pg_catalog.pg_namespace pn
left join pg_catalog.pg_depend pd on pd.objid = pn.oid and pd.classid = 'pg_catalog.pg_namespace'::regclass
where pd.deptype is null
  and not pn.nspname like any($1)
  and pn.nspowner::regrole::text != 'supabase_admin'
order by pn.nspname`;

function isSslDebugEnabled(): boolean {
  return (process.env["SUPABASE_SSL_DEBUG"] ?? "").toLowerCase() === "true";
}

function shouldFallbackToBashMigra(message: string): boolean {
  return (
    message.includes("Fatal JavaScript out of memory") ||
    message.includes("Ineffective mark-compacts near heap limit")
  );
}

/** Builds the shared SOURCE/TARGET/SSL/schema env for both migra paths. */
const buildMigraEnv = Effect.fnUntraced(function* (params: {
  readonly source: string;
  readonly target: string;
  readonly schema: ReadonlyArray<string>;
}) {
  const probe = yield* PgDeltaSslProbe;
  const env: Record<string, string> = {
    SOURCE: params.source,
    TARGET: params.target,
  };
  if (isSslDebugEnabled()) env["SUPABASE_SSL_DEBUG"] = "true";
  // Probe the target for TLS; if it speaks TLS, inject the embedded CA bundle as SSL_CA.
  const requireSsl = yield* probe.requireSsl(params.target);
  if (requireSsl) env["SSL_CA"] = PG_DELTA_CA_BUNDLE;
  if (params.schema.length > 0) {
    env["INCLUDED_SCHEMAS"] = params.schema.join(",");
  } else {
    env["EXCLUDED_SCHEMAS"] = MIGRA_MANAGED_SCHEMAS.join(",");
  }
  return env;
});

/**
 * Loads the target's user-defined schemas for the bash fallback: migra.sh iterates over an
 * explicit schema list and cannot diff in exclude mode.
 */
const loadTargetUserSchemas = Effect.fnUntraced(function* (
  target: string,
  connectOptions: DbConnectOptions,
) {
  const connection = yield* DbConnection;
  const input = parseConnectionString(target);
  if (input === undefined) {
    return yield* Effect.fail(
      new MigraSchemaLoadError({
        message: "failed to list schemas: invalid target connection string",
      }),
    );
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* connection.connect(input, connectOptions).pipe(
        Effect.mapError(
          (cause) =>
            new MigraSchemaLoadError({
              message: `failed to list schemas: ${cause.message}`,
            }),
        ),
      );
      const rows = yield* session.query(listSchemasSql, [LIST_SCHEMAS_EXCLUDE]).pipe(
        Effect.mapError(
          (cause) =>
            new MigraSchemaLoadError({
              message: `failed to list schemas: ${cause.message}`,
            }),
        ),
      );
      return rows.map((row) => String(row["nspname"]));
    }),
  );
});

/**
 * The OOM bash fallback: runs migra in the `supabase/migra` Docker image over the host
 * network. When no `--schema` is given, the included schemas are loaded from the target and
 * passed as positional args to migra.sh.
 */
const diffMigraBash = Effect.fnUntraced(function* (params: {
  readonly source: string;
  readonly target: string;
  readonly schema: ReadonlyArray<string>;
  readonly connectOptions: DbConnectOptions;
}) {
  const docker = yield* DockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* NetworkIdFlag;
  const schema =
    params.schema.length > 0
      ? params.schema
      : yield* loadTargetUserSchemas(params.target, params.connectOptions);
  const env: Record<string, string> = { SOURCE: params.source, TARGET: params.target };
  if (isSslDebugEnabled()) env["SUPABASE_SSL_DEBUG"] = "true";
  // The script runs as a string, so command-line args must be set manually via `set --`
  // for migra.sh's `"$@"` loop to see the schema list.
  const args = `set -- ${schema.join(" ")};`;
  // Add the Linux `host.docker.internal:host-gateway` mapping, and use a named network when
  // `--network-id` is set, so this fallback reaches the database like the primary path does.
  const networkId = Option.getOrUndefined(networkIdFlag);
  const network =
    networkId !== undefined && networkId.length > 0
      ? { _tag: "named" as const, name: networkId }
      : { _tag: "host" as const };
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
  const result = yield* docker
    .runCapture({
      image: getRegistryImageUrl(MIGRA_IMAGE),
      cmd: ["/bin/sh", "-c", args + migraDiffShellScript],
      env,
      binds: [],
      workingDir: Option.none(),
      securityOpt: [],
      extraHosts,
      network,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new MigraDiffError({
            message: `error diffing schema: ${cause.message}`,
            // Distinguish a daemon-down / registry-pull failure at the docker boundary from
            // a genuine user-SQL diff failure.
            docker: cause.reason === "spawn" || cause.daemonDown ? "daemon" : "pull",
          }),
      ),
    );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new MigraDiffError({
        message: `error diffing schema:\n${result.stderr}`,
      }),
    );
  }
  return new TextDecoder().decode(result.stdout);
});

/**
 * Diffs SOURCE → TARGET with migra via the edge-runtime template, falling back to the
 * `supabase/migra` Docker image when the edge-runtime worker runs out of memory.
 * `source`/`target` are live Postgres URLs (the shadow source and the diff target).
 */
export const diffMigra = Effect.fnUntraced(function* (
  ctx: PgDeltaContext,
  params: {
    readonly source: string;
    readonly target: string;
    readonly schema: ReadonlyArray<string>;
    readonly connectOptions: DbConnectOptions;
  },
) {
  const edgeRuntime = yield* EdgeRuntimeScript;
  const env = yield* buildMigraEnv(params);
  const result = yield* edgeRuntime
    .run({
      script: migraDiffScript,
      env,
      binds: [`${edgeRuntimeId(ctx.projectId)}:/root/.cache/deno:rw`],
      errPrefix: "error diffing schema",
      denoVersion: ctx.denoVersion,
      workdir: ctx.cwd,
    })
    .pipe(
      Effect.catch((cause) =>
        shouldFallbackToBashMigra(cause.message)
          ? diffMigraBash(params)
          : Effect.fail(new MigraDiffError({ message: cause.message })),
      ),
    );
  return typeof result === "string" ? result : result.stdout;
});
