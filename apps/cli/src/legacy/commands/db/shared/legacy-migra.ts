import { Effect, Option } from "effect";

import { LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  LegacyDbConnection,
  type LegacyDbConnectOptions,
} from "../../../shared/legacy-db-connection.service.ts";
import { parseLegacyConnectionString } from "../../../shared/legacy-db-config.parse.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LEGACY_PG_DELTA_CA_BUNDLE } from "../../../shared/legacy-pgdelta-ssl.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import {
  legacyMigraDiffScript,
  legacyMigraDiffShellScript,
} from "./legacy-migra.deno-templates.ts";
import { LegacyMigraDiffError, LegacyMigraSchemaLoadError } from "./legacy-migra.errors.ts";
import { legacyEdgeRuntimeId, type LegacyPgDeltaContext } from "./legacy-pgdelta.ts";

/**
 * The migra Docker image, parsed by Go from its embedded Dockerfile
 * (`apps/cli-go/pkg/config/templates/Dockerfile:19` → `config.Images.Migra`).
 * Used only by the OOM bash fallback (`DiffSchemaMigraBash`); the common
 * edge-runtime path runs `@pgkit/migra` instead.
 */
const LEGACY_MIGRA_IMAGE = "supabase/migra:3.0.1663481299";

/**
 * Schemas excluded from a no-`--schema` migra diff. Verbatim from Go's
 * `managedSchemas` (`apps/cli-go/internal/db/diff/migra.go:26-56`): local-dev,
 * extension-owned, deprecated-extension, and Supabase-managed schemas. Passed as
 * `EXCLUDED_SCHEMAS` to the edge-runtime template.
 */
const LEGACY_MIGRA_MANAGED_SCHEMAS: ReadonlyArray<string> = [
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

/**
 * LIKE patterns excluded by `ListUserSchemas` when resolving the migra bash
 * fallback's schema list. Verbatim from Go's `migration.ManagedSchemas`
 * (`apps/cli-go/pkg/migration/drop.go:19-31`).
 */
const LEGACY_LIST_SCHEMAS_EXCLUDE: ReadonlyArray<string> = [
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

/** Verbatim from Go's `migration.ListSchemas` (`pkg/migration/queries/list.sql`). */
const LEGACY_LIST_SCHEMAS_SQL = `-- List user defined schemas, excluding
--  Extension created schemas
--  Supabase managed schemas
select pn.nspname
from pg_namespace pn
left join pg_depend pd on pd.objid = pn.oid
where pd.deptype is null
  and not pn.nspname like any($1)
  and pn.nspowner::regrole::text != 'supabase_admin'
order by pn.nspname`;

/** Mirrors Go's `types.IsSSLDebugEnabled` (`internal/gen/types/types.go:201`). */
function legacyIsSslDebugEnabled(): boolean {
  return (process.env["SUPABASE_SSL_DEBUG"] ?? "").toLowerCase() === "true";
}

/** Mirrors Go's `shouldFallbackToLegacyMigra` (`internal/db/diff/migra.go:155`). */
function legacyShouldFallbackToBashMigra(message: string): boolean {
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
  const probe = yield* LegacyPgDeltaSslProbe;
  const env: Record<string, string> = {
    SOURCE: params.source,
    TARGET: params.target,
  };
  if (legacyIsSslDebugEnabled()) env["SUPABASE_SSL_DEBUG"] = "true";
  // Go's GetRootCA: probe the target for TLS; if it speaks TLS, inject the
  // embedded CA bundle as SSL_CA (`internal/gen/types/types.go:124-148`).
  const requireSsl = yield* probe.requireSsl(params.target);
  if (requireSsl) env["SSL_CA"] = LEGACY_PG_DELTA_CA_BUNDLE;
  if (params.schema.length > 0) {
    env["INCLUDED_SCHEMAS"] = params.schema.join(",");
  } else {
    env["EXCLUDED_SCHEMAS"] = LEGACY_MIGRA_MANAGED_SCHEMAS.join(",");
  }
  return env;
});

/**
 * Loads the target's user-defined schemas for the bash fallback (the bash
 * migra.sh iterates over an explicit schema list and cannot diff in exclude
 * mode). Mirrors Go's `loadSchema` → `migration.ListUserSchemas`
 * (`internal/db/diff/migra.go:99` / `pkg/migration/drop.go:40`).
 */
const loadTargetUserSchemas = Effect.fnUntraced(function* (
  target: string,
  connectOptions: LegacyDbConnectOptions,
) {
  const connection = yield* LegacyDbConnection;
  const input = parseLegacyConnectionString(target);
  if (input === undefined) {
    return yield* Effect.fail(
      new LegacyMigraSchemaLoadError({
        message: "failed to list schemas: invalid target connection string",
      }),
    );
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* connection.connect(input, connectOptions).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyMigraSchemaLoadError({
              message: `failed to list schemas: ${cause.message}`,
            }),
        ),
      );
      const rows = yield* session
        .query(LEGACY_LIST_SCHEMAS_SQL, [LEGACY_LIST_SCHEMAS_EXCLUDE])
        .pipe(
          Effect.mapError(
            (cause) =>
              new LegacyMigraSchemaLoadError({
                message: `failed to list schemas: ${cause.message}`,
              }),
          ),
        );
      return rows.map((row) => String(row["nspname"]));
    }),
  );
});

/**
 * The OOM bash fallback: run migra in the `supabase/migra` Docker image over the
 * host network. Mirrors Go's `DiffSchemaMigraBash`
 * (`internal/db/diff/migra.go:60`): when no `--schema` is given the included
 * schemas are loaded from the target, then passed as positional args to migra.sh.
 */
const diffMigraBash = Effect.fnUntraced(function* (params: {
  readonly source: string;
  readonly target: string;
  readonly schema: ReadonlyArray<string>;
  readonly connectOptions: LegacyDbConnectOptions;
}) {
  const docker = yield* LegacyDockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* LegacyNetworkIdFlag;
  const schema =
    params.schema.length > 0
      ? params.schema
      : yield* loadTargetUserSchemas(params.target, params.connectOptions);
  const env: Record<string, string> = { SOURCE: params.source, TARGET: params.target };
  if (legacyIsSslDebugEnabled()) env["SUPABASE_SSL_DEBUG"] = "true";
  // Passing the script as a string means command-line args must be set manually
  // via `set --` so migra.sh's `"$@"` loop sees the schema list (Go's `args`).
  const args = `set -- ${schema.join(" ")};`;
  // Go's bash fallback (`DiffSchemaMigraBash`) routes through `DockerStart`
  // (`internal/utils/docker.go:266-271`), which appends the Linux
  // `host.docker.internal:host-gateway` mapping and overrides host networking with
  // `--network-id` when set. Mirror that here so the fallback reaches the database
  // on custom-network / `host.docker.internal` setups, matching the primary path.
  const networkId = Option.getOrUndefined(networkIdFlag);
  const network =
    networkId !== undefined && networkId.length > 0
      ? { _tag: "named" as const, name: networkId }
      : { _tag: "host" as const };
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
  const result = yield* docker
    .runCapture({
      image: legacyGetRegistryImageUrl(LEGACY_MIGRA_IMAGE),
      cmd: ["/bin/sh", "-c", args + legacyMigraDiffShellScript],
      env,
      binds: [],
      workingDir: Option.none(),
      securityOpt: [],
      extraHosts,
      network,
    })
    .pipe(
      Effect.mapError(
        (cause) => new LegacyMigraDiffError({ message: `error diffing schema: ${cause.message}` }),
      ),
    );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new LegacyMigraDiffError({
        message: `error diffing schema:\n${result.stderr}`,
      }),
    );
  }
  return new TextDecoder().decode(result.stdout);
});

/**
 * Diffs SOURCE → TARGET with migra via the edge-runtime template
 * (`@pgkit/migra` + `@pgkit/client`), falling back to the `supabase/migra`
 * Docker image when the edge-runtime worker runs out of memory. Mirrors Go's
 * `DiffSchemaMigra` (`internal/db/diff/migra.go:109`). `source`/`target` are
 * live Postgres URLs (the shadow source and the diff target). Symmetric with
 * `legacyDiffPgDelta`: a free function over a `LegacyPgDeltaContext`, not a
 * service.
 */
export const legacyDiffMigra = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  params: {
    readonly source: string;
    readonly target: string;
    readonly schema: ReadonlyArray<string>;
    readonly connectOptions: LegacyDbConnectOptions;
  },
) {
  const edgeRuntime = yield* LegacyEdgeRuntimeScript;
  const env = yield* buildMigraEnv(params);
  const result = yield* edgeRuntime
    .run({
      script: legacyMigraDiffScript,
      env,
      binds: [`${legacyEdgeRuntimeId(ctx.projectId)}:/root/.cache/deno:rw`],
      errPrefix: "error diffing schema",
      denoVersion: ctx.denoVersion,
    })
    .pipe(
      Effect.catch((cause) =>
        legacyShouldFallbackToBashMigra(cause.message)
          ? diffMigraBash(params)
          : Effect.fail(new LegacyMigraDiffError({ message: cause.message })),
      ),
    );
  return typeof result === "string" ? result : result.stdout;
});
