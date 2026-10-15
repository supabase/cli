import * as net from "node:net";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Duration, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { type CliConfigKeyOrigin } from "../config/cli-config-key.ts";
import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { CliConfigValues, type ResolvedCliConfig } from "../config/cli-config-values.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { projectRefPicker } from "../config/project-ref.layer.ts";
import { ProjectRefResolver, PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
} from "./global-flags.ts";
import { CommandTarget } from "../shared/output/command-target.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";
import { type ConnectSuggestionContext, SUGGEST_ENV_VAR } from "./connect-errors.ts";
import { DbConnection, type PgConnInput } from "./db-connection.service.ts";
import { IdentityStitch } from "./identity-stitch.ts";
import {
  linkedDbResolverRuntimeLayer,
  type LinkedDbResolverRuntimeRequirements,
} from "./management-api-runtime.layer.ts";
import * as Errors from "./db-config.errors.ts";
import {
  layeredParseEnv,
  poolerConfigFromConnectionString,
  parseConnectionString,
  redactConnectionString,
} from "./db-config.parse.ts";
import { DbConfigResolver, type DbConfigError } from "./db-config.service.ts";
import { loadProjectEnvValues, readDbToml } from "./db-config.toml-read.ts";
import type { DbConfigFlags, DbConnectionInput } from "./db-config.types.ts";
import { rejectPasswordWithDirectTarget } from "./db-target-flags.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { getHostname } from "./hostname.ts";
import { mapHttpError } from "./http-errors.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { stackLocalDatabaseConn } from "./stack-local-database.ts";
import { block, type OperationEntry } from "./command-permissions/model.ts";
import { renderDbUrlTarget, renderLocalTarget } from "./target/target-identity.ts";
import { TargetPasswordConflictError } from "./target/target.errors.ts";

const linkedEntries: ReadonlyArray<Omit<OperationEntry, "source">> = [
  {
    operationId: "v1-create-login-role",
    kind: "required",
    when: [{ flag: "password", present: false }],
    context:
      "no database password supplied by the command (an empty one still mints a login role) or set in SUPABASE_DB_PASSWORD or the project .env (an ad-hoc project ref ignores the last two)",
  },
  {
    operationId: "v1-get-pooler-config",
    kind: "required",
    when: [{ flag: "project-ref" }],
    context:
      "the direct database host is unreachable (IPv4-only network) and there is no usable saved supabase/.temp/pooler-url",
  },
  {
    operationId: "v1-get-pooler-config",
    kind: "required",
    when: [{ flag: "project-ref", oneOf: [""] }],
    context:
      "an empty --project-ref falls back to the linked project but still allows the pooler fetch, when the direct database host is unreachable (IPv4-only network) and there is no usable saved supabase/.temp/pooler-url",
  },
  {
    operationId: "v1-list-all-network-bans",
    kind: "best-effort",
    when: [{ flag: "password", present: false }],
    context:
      "after three failed attempts to connect through the pooler as the temporary login role",
  },
  {
    operationId: "v1-delete-network-bans",
    kind: "best-effort",
    when: [{ flag: "password", present: false }],
    context:
      "after three failed attempts to connect through the pooler as the temporary login role",
  },
  ...projectRefPicker.operations,
];

/**
 * The same calls as {@link dbConfig} without its target condition, for a command that reaches the
 * linked path some other way: `db diff --from linked`, a `--linked` flag with no default target, or
 * a target prompt.
 */
export const dbConfigLinked = block("db-config", linkedEntries);

/**
 * `DbConfigResolver` on the linked path; `--local` and `--db-url` make no API calls. Commands
 * include it with `withDbTarget`. The container retry that `db dump` and `db pull` run is
 * {@link dbConfigPoolerFallback}; `gen types --project-id` fetches the
 * pooler config without `--project-ref`, so that command declares its own entry.
 */
export const dbConfig = block(
  "db-config",
  linkedEntries.map((entry) => ({
    ...entry,
    when: [{ dbTarget: ["linked" as const] }, ...(entry.when ?? [])],
  })),
);

/**
 * `DbConfigResolver.resolvePoolerFallback`, the pooler retry after a linked dump, declarative export
 * or pull diff fails with an IPv6 connectivity error against a direct host the CLI could reach.
 */
export const dbConfigPoolerFallback = block("db-config-pooler-fallback", [
  {
    operationId: "v1-get-pooler-config",
    kind: "required",
    when: [{ dbTarget: ["linked"] }],
    context:
      "a linked dump, declarative export or pull diff fails with an IPv6 connectivity error against the direct database host, and there is no usable saved supabase/.temp/pooler-url",
  },
  {
    operationId: "v1-create-login-role",
    kind: "required",
    when: [{ dbTarget: ["linked"] }, { flag: "password", present: false }],
    context:
      "the same retry, and no database password supplied by the command (an empty one still mints a login role) or set in SUPABASE_DB_PASSWORD or the project .env",
  },
  {
    operationId: "v1-list-all-network-bans",
    kind: "best-effort",
    when: [{ dbTarget: ["linked"] }, { flag: "password", present: false }],
    context: "the same retry, after three failed attempts to connect as the temporary login role",
  },
  {
    operationId: "v1-delete-network-bans",
    kind: "best-effort",
    when: [{ dbTarget: ["linked"] }, { flag: "password", present: false }],
    context: "the same retry, after three failed attempts to connect as the temporary login role",
  },
]);

const DIRECT_PORT = 5432;
const TCP_PROBE_TIMEOUT = Duration.seconds(5);
const MAX_RETRIES = 8;
const BACKOFF_INITIAL = Duration.seconds(3);
const BACKOFF_MAX = Duration.seconds(60);

const loginRoleErrorMapper = mapHttpError({
  networkError: Errors.DbConfigLoginRoleNetworkError,
  statusError: Errors.DbConfigLoginRoleStatusError,
  networkMessage: (cause) => `failed to initialise login role: ${cause}`,
  statusMessage: (status, body) => `unexpected login role status ${status}: ${body}`,
});

const listBansErrorMapper = mapHttpError({
  networkError: Errors.DbConfigListBansNetworkError,
  statusError: Errors.DbConfigListBansStatusError,
  networkMessage: (cause) => `failed to list network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected list bans status ${status}: ${body}`,
});

const unbanErrorMapper = mapHttpError({
  networkError: Errors.DbConfigUnbanNetworkError,
  statusError: Errors.DbConfigUnbanStatusError,
  networkMessage: (cause) => `failed to remove network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected remove bans status ${status}: ${body}`,
});

/** Compares against the resolved local services hostname, not a hard-coded loopback. */
function isLocalDatabase(
  host: string,
  localHost: string,
  port: number,
  dbPort: number,
  shadowPort: number,
): boolean {
  return host === localHost && (port === dbPort || port === shadowPort);
}

/** Stack databases listen on loopback, so only loopback or services-hostname URLs can match one. */
function mayBeStackDatabaseHost(host: string, localHost: string): boolean {
  return (
    host === localHost ||
    host === "localhost" ||
    host === "::1" ||
    (net.isIPv4(host) && host.startsWith("127."))
  );
}

/** Best-effort TCP reachability probe with a 5s timeout. */
const tcpReachable = (host: string, port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = net.connect({ host, port });
    const settle = (reachable: boolean) => {
      socket.destroy();
      resume(Effect.succeed(reachable));
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({ duration: TCP_PROBE_TIMEOUT, orElse: () => Effect.succeed(false) }),
    Effect.tap((reachable) => Effect.annotateCurrentSpan("network.reachable", reachable)),
    Effect.withSpan("DbConfig.tcpProbe", { attributes: { "server.port": port } }),
  );

// POST /v1/projects/{ref}/cli/login-role → mint a temporary postgres role. The Management API
// client is built lazily via `CommandPlatformApiFactory.make` (not the eager
// `CommandPlatformApi` stack), so the access token is resolved only here — when a temp role is
// actually minted. `--linked --password` returns before reaching this, so it stays auth-free;
// `--local`/`--db-url` never build this layer at all.
const initLoginRole = Effect.fn("DbConfig.initLoginRole")(function* (
  ref: string,
  conn: PgConnInput,
) {
  const output = yield* Output;
  const api = yield* (yield* CommandPlatformApiFactory).make;
  // Written to stderr unconditionally (not gated on --debug).
  yield* output.raw("Initialising login role...\n", "stderr");
  const role = yield* api.v1
    .createLoginRole({ ref, read_only: false })
    .pipe(Effect.catch(loginRoleErrorMapper));
  return { ...conn, user: role.role, password: role.password };
});

const listAndUnban = Effect.fnUntraced(function* (ref: string, removeBans: boolean) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const bans = yield* api.v1.listAllNetworkBans({ ref }).pipe(Effect.catch(listBansErrorMapper));
  const addrs = bans.banned_ipv4_addresses;
  if (addrs.length === 0) return;
  if (!removeBans) {
    return yield* new Errors.LinkedDbNetworkBannedError({
      message: `Network bans (${addrs.join(", ")}) may be blocking the connection, and removing them needs approval.`,
      suggestion:
        "Re-run with --yes to remove the bans, or run supabase network-bans remove --db-unban-ip <ip> first.",
    });
  }
  yield* api.v1
    .deleteNetworkBans({ ref, ipv4_addresses: [...addrs], requester_ip: false })
    .pipe(Effect.catch(unbanErrorMapper));
});

// Verify-connect with backoff while the pooler refreshes the temp password. On attempt ≥ 3,
// clear any network ban on the requester.
const waitForTempRole = Effect.fn("DbConfig.waitForTempRole")(function* (
  ref: string,
  conn: PgConnInput,
  dnsResolver: "native" | "https",
  removeBans: boolean,
) {
  const dbConn = yield* DbConnection;
  const debug = yield* DebugLogger;
  const attempt = (n: number): Effect.Effect<void, DbConfigError, CommandPlatformApiFactory> =>
    // The temp-role probe always targets the remote Supavisor pooler, so it connects with TLS
    // and honors `--dns-resolver`.
    Effect.scoped(dbConn.connect(conn, { isLocal: false, dnsResolver }).pipe(Effect.asVoid)).pipe(
      Effect.ensuring(Effect.annotateCurrentSpan("retry.attempt_count", n)),
      Effect.catch((cause) => {
        // 8 retries after the initial attempt allows 9 total attempts. `n` is 1-based, so give
        // up only after attempt 9 (`n > MAX_RETRIES`), not at attempt 8.
        if (n > MAX_RETRIES) {
          return Effect.fail(
            new Errors.DbConfigConnectTempRoleError({
              message: `failed to connect as temp role: ${cause.message}`,
              suggestion: SUGGEST_ENV_VAR,
            }),
          );
        }
        // From the 3rd failure onward, clear any network ban on the requester. Uses a
        // deterministic backoff curve rather than jittered, since jitter only matters under
        // concurrent pooler refreshes.
        const delayMs = Math.min(
          Duration.toMillis(BACKOFF_INITIAL) * 1.5 ** (n - 1),
          Duration.toMillis(BACKOFF_MAX),
        );
        return Effect.gen(function* () {
          // A transient ban-list/unban failure must not propagate out of the retry loop; log
          // it to --debug, then discard. An unapproved ban removal is the one failure that ends it.
          if (n >= 3) {
            yield* listAndUnban(ref, removeBans).pipe(
              Effect.catch((banError) =>
                banError._tag === "LinkedDbNetworkBannedError"
                  ? Effect.fail(banError)
                  : debug.debug(banError.message),
              ),
            );
          }
          yield* debug.debug(`Retry (${n}/${MAX_RETRIES}): ${cause.message}`);
          yield* Effect.sleep(Duration.millis(delayMs));
          return yield* attempt(n + 1);
        });
      }),
    );
  return yield* attempt(1);
});

/**
 * Parse + validate the configured pooler connection string. Returns `None` (treated as "no
 * pooler" → IPv6 error) on any validation failure.
 */
const poolerConfigFrom = Effect.fnUntraced(function* (
  ref: string,
  connectionString: string,
  poolerHost: string,
) {
  const debug = yield* DebugLogger;
  const result = yield* poolerConfigFromConnectionString(ref, connectionString, poolerHost);
  if (result._tag === "ok") return Option.some(result.conn);
  yield* debug.debug(result.reason);
  return Option.none();
});

const noticedWithheldPassword = new WeakSet<ResolvedCliConfig>();

const describePasswordOrigin = (origin: CliConfigKeyOrigin): string => {
  switch (origin.tier) {
    case "flag":
      return `--${origin.flag}`;
    case "shell":
      return `${origin.envName} (environment)`;
    case "projectEnv":
      return origin.file === undefined ? origin.envName : `${origin.envName} (${origin.file})`;
    default:
      return origin.tier;
  }
};

/**
 * A `--password` the caller bound on {@link DbConfigFlags} is passed to
 * {@link resolveLinkedPassword} as the caller's password, so it wins over `SUPABASE_DB_PASSWORD` and
 * the project `.env` just like the flag tier does, and no login role is minted for it. An
 * explicitly empty `--password` asks for a temporary login role even when the env holds one; the
 * flag binding drops empty strings, so this is the only way that request reaches the resolver.
 */
const passwordFlag = (password: Option.Option<string> | undefined): Option.Option<string> =>
  password ?? Option.none();

const rejectTargetPassword = (
  target: "local" | "db-url",
  password: Option.Option<string>,
): Effect.Effect<void, TargetPasswordConflictError> =>
  Option.isNone(Option.filter(password, (value) => value.length > 0))
    ? Effect.void
    : Effect.fail(
        new TargetPasswordConflictError({
          target,
          message:
            target === "db-url"
              ? "--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres"
              : "--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.",
        }),
      );

const loadFailureToDbConfigError = <E extends { readonly _tag: string; readonly message: string }>(
  error: E,
) =>
  Errors.isPassthroughLoadFailure(error)
    ? error
    : new Errors.DbConfigLoadError({ message: error.message });

/**
 * Resolves the database password through `CliConfigValues` (`--password` > shell env > project
 * `.env*`). `workdir` is an explicit parameter (never `CommandSettings.workdir`) so callers whose
 * real workdir has diverged from that cwd-walked value (e.g. `bootstrap`, after its own
 * `process.chdir`) resolve against the correct directory. `explicit` is a password the caller
 * already holds, such as the one `bootstrap` just set on a new project. An empty result means "mint
 * a temporary login role".
 */
export const resolveLinkedPassword = Effect.fn("DbConfig.resolveLinkedPassword")(function* (
  ref: string,
  workdir: string,
  explicit: Option.Option<string>,
  hasPasswordFlag = false,
) {
  const debug = yield* DebugLogger;
  if (Option.isSome(explicit)) {
    yield* debug.debug("Using the database password supplied by the caller...");
    return explicit.value;
  }
  const output = yield* Output;
  const resolvedConfig = yield* (yield* CliConfigValues)
    .load({ workdir, projectRef: Option.some(ref) })
    .pipe(Effect.mapError(loadFailureToDbConfigError));
  const resolved = yield* resolvedConfig
    .get(CliConfigKeys.linkedDb.password)
    .pipe(Effect.mapError(loadFailureToDbConfigError));
  const withheld = resolvedConfig.withheldEnv.find(
    (entry) => entry.path === CliConfigKeys.linkedDb.password.path,
  );
  if (
    withheld !== undefined &&
    resolved.origin.tier !== "flag" &&
    !noticedWithheldPassword.has(resolvedConfig)
  ) {
    noticedWithheldPassword.add(resolvedConfig);
    yield* output.warn(
      `Not sending ${withheld.envName} to ${withheld.targetRef}: this directory is linked to ${withheld.linkedRef}. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN).${
        hasPasswordFlag ? ` Pass --password to use a password for ${withheld.targetRef}.` : ""
      }`,
    );
  }
  if (Option.isNone(resolved.value)) {
    yield* debug.debug("No database password found; using a temporary login role...");
    return "";
  }
  yield* debug.debug(`Using database password from ${describePasswordOrigin(resolved.origin)}...`);
  return resolved.value.value;
});

/**
 * Resolve the IPv4 transaction pooler connection for `ref`. Returns `None` when no pooler URL is
 * configured or it fails validation, so the caller can keep the original error. With a password,
 * uses it directly; without one, mints a temp login role and verify-connects through the pooler.
 *
 * `workdir`/`poolerHost` are explicit parameters (see {@link resolveLinkedPassword}).
 */
const resolvePoolerConn = Effect.fn("DbConfig.resolvePoolerConn")(function* (
  ref: string,
  workdir: string,
  poolerHost: string,
  dnsResolver: "native" | "https",
  password: string,
  // The container-fallback path falls back to the Management API's primary pooler config when
  // no `.temp/pooler-url` is saved; the resolve-time IPv6 path uses the saved URL only and
  // errors otherwise, so this defaults off.
  fetchFromApi = false,
  // For an ad-hoc `--project-id` ref the saved `.temp/pooler-url` belongs to the
  // (possibly different) linked workdir, so ignore it and resolve the pooler for
  // `ref` from the Management API instead.
  ignoreSavedUrl = false,
  resolveVaultSecrets = true,
  removeNetworkBans = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Linked-path read: merge the `[remotes.<ref>]` override, so this matches the ref-aware read
  // on the main linked branch rather than validating base config. For an ad-hoc `--project-id`
  // ref, skip the saved workdir pooler URL because it belongs to the linked project, not
  // necessarily the explicit ref.
  const tomlValues = yield* readDbToml(fs, path, workdir, ref, {
    resolveVaultSecrets,
  });
  let connectionString = ignoreSavedUrl
    ? undefined
    : Option.getOrUndefined(tomlValues.poolerConnectionString);
  if (connectionString === undefined) {
    if (!fetchFromApi) return Option.none<PgConnInput>();
    // No saved pooler URL → fetch the primary pooler config from the Management API. Any API
    // failure means "no fallback", so swallow it to `None`.
    const api = yield* (yield* CommandPlatformApiFactory).make;
    const configsOpt = yield* api.v1.getPoolerConfig({ ref }).pipe(Effect.option);
    if (Option.isNone(configsOpt)) return Option.none<PgConnInput>();
    const primary = configsOpt.value.find((config) => config.database_type === "PRIMARY");
    if (primary === undefined) return Option.none<PgConnInput>();
    connectionString = primary.connection_string;
  }
  let pooler = Option.none<PgConnInput>();
  if (connectionString !== undefined) {
    pooler = yield* poolerConfigFrom(ref, connectionString, poolerHost);
  }
  if (Option.isNone(pooler) && fetchFromApi) {
    const api = yield* (yield* CommandPlatformApiFactory).make;
    const configsOpt = yield* api.v1.getPoolerConfig({ ref }).pipe(Effect.option);
    if (Option.isSome(configsOpt)) {
      const primary = configsOpt.value.find((config) => config.database_type === "PRIMARY");
      if (primary !== undefined) {
        pooler = yield* poolerConfigFrom(ref, primary.connection_string, poolerHost);
      }
    }
  }
  if (Option.isNone(pooler)) return Option.none<PgConnInput>();
  const poolerConn = pooler.value;
  if (password.length > 0) return Option.some({ ...poolerConn, password });
  // Mint a temp role; preserve Supavisor's `<user>.<ref>` tenant suffix.
  const originalUser = poolerConn.user;
  const withRole = yield* initLoginRole(ref, poolerConn);
  const finalUser = originalUser.endsWith(`.${ref}`) ? `${withRole.user}.${ref}` : withRole.user;
  const tempConn = { ...withRole, user: finalUser };
  yield* waitForTempRole(ref, tempConn, dnsResolver, removeNetworkBans);
  return Option.some(tempConn);
});

/**
 * Resolves the linked project's connection: dial the direct host, and — when unreachable (the
 * common case, since new Supabase projects have IPv6-only direct DB hosts) — transparently fall
 * back to the project's IPv4 transaction pooler.
 *
 * `workdir`/`projectHost`/`poolerHost` are explicit parameters rather than read from
 * `CommandSettings`, so this is safely callable from a context whose real workdir has diverged
 * from `CommandSettings.workdir`'s cwd-walked value — e.g. `bootstrap`, whose own
 * `process.chdir` happens after that layer is built. `bootstrap` calls this directly with its
 * own local `workdir`/`projectRef`/`created.dbPassword`, without going through
 * `DbConfigResolver`/`ProjectRefResolver` (both keyed off the ambient, potentially-stale
 * `CommandSettings.workdir`).
 */
export const resolveLinkedConn = Effect.fn("DbConfig.resolveLinkedConn")(function* (
  ref: string,
  workdir: string,
  projectHost: string,
  poolerHost: string,
  dnsResolver: "native" | "https",
  explicitPassword: Option.Option<string>,
  options: {
    readonly adHocProjectRef?: boolean;
    readonly resolveVaultSecrets?: boolean;
    /**
     * Requests the Management API pooler-config fetch on an IPv4-only network
     * independent of `adHocProjectRef`'s saved-URL semantics — see
     * `DbConfigFlags.linkedProjectRef`'s doc comment. Set when the caller
     * supplied an explicit ref (`--project-ref`/`--project-id`) rather than
     * falling back to `.temp/project-ref`, so an unlinked or mismatched-tenant
     * workdir still reaches the primary pooler config instead of dead-ending in
     * the "run supabase link" IPv6 error.
     */
    readonly fetchPoolerFromApi?: boolean;
    /** Whether the calling command binds `--password`, so the withheld-password notice can name it. */
    readonly hasPasswordFlag?: boolean;
    /** When false, a network ban that blocks the temp role fails with `LinkedDbNetworkBannedError` instead of being removed. */
    readonly removeNetworkBans?: boolean;
  } = {},
) {
  const {
    adHocProjectRef = false,
    resolveVaultSecrets = true,
    fetchPoolerFromApi = false,
    hasPasswordFlag = false,
    removeNetworkBans = true,
  } = options;
  const dbPassword = yield* resolveLinkedPassword(ref, workdir, explicitPassword, hasPasswordFlag);
  const host = `db.${ref}.${projectHost}`;
  const base: PgConnInput = {
    host,
    port: DIRECT_PORT,
    user: "postgres",
    password: dbPassword,
    database: "postgres",
  };

  const reachable = yield* tcpReachable(host, DIRECT_PORT);
  yield* Effect.annotateCurrentSpan("db.direct_reachable", reachable);
  if (reachable) {
    if (base.password.length > 0) return base;
    return yield* initLoginRole(ref, base);
  }

  // Direct host unreachable (IPv6-only network) → try the pooler. For an ad-hoc `--project-id`
  // ref the command already holds a Management API token, so fall back to the API pooler config
  // (and ignore the workdir's saved pooler URL) rather than failing with the IPv6 suggestion. An
  // explicit `--project-ref` on a non-ad-hoc `db` command keeps `ignoreSavedUrl` at the
  // saved-URL-first default (the tenant-mismatch check in `poolerConfigFrom` still rejects a
  // stale saved URL for a different ref), but independently requests the same API fetch via
  // `fetchPoolerFromApi` so an unlinked or mismatched-tenant workdir doesn't dead-end in the
  // IPv6 error.
  const poolerConn = yield* resolvePoolerConn(
    ref,
    workdir,
    poolerHost,
    dnsResolver,
    base.password,
    adHocProjectRef || fetchPoolerFromApi,
    adHocProjectRef,
    resolveVaultSecrets,
    removeNetworkBans,
  );
  if (Option.isNone(poolerConn)) {
    return yield* new Errors.DbConfigIpv6Error({
      message: "IPv6 is not supported on your current network",
      suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
    });
  }
  return poolerConn.value;
});

/** The resolver without its `StackApi`, for callers that supply their own stack boundary. */
export const dbConfigResolverLayer = Layer.effect(
  DbConfigResolver,
  Effect.gen(function* () {
    const cliSettings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeInfo = yield* RuntimeInfo;
    const crypto = yield* Crypto.Crypto;
    const debug = yield* DebugLogger;
    const output = yield* Output;
    const dbConn = yield* DbConnection;
    const configValues = yield* CliConfigValues;
    const commandTarget = yield* CommandTarget;
    // `resolveLinkedConn`/`resolvePoolerConn` (etc.) are standalone functions that yield their
    // own `FileSystem`/`Path`/`DebugLogger`/`Output`/`DbConnection` (so bootstrap can call them
    // directly from its own ambient context). Calling them from here would otherwise leak those
    // services into `resolve`/`resolvePoolerFallback`'s R (the interface promises `never`), so
    // every call site below re-closes the gap by additionally providing this layer of
    // already-resolved values alongside `linkedDbResolverRuntimeLayer`.
    const localAmbientServices = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(DebugLogger, debug),
      Layer.succeed(Output, output),
      Layer.succeed(DbConnection, dbConn),
      Layer.succeed(CliConfigValues, configValues),
    );

    // Profile context for the connect-failure suggestion. Snapshot it once and attach it to
    // every resolved connection so the driver layer can render a hint on a refused/auth/IPv6
    // connect error.
    const suggestionContext: ConnectSuggestionContext = {
      dashboardUrl: cliSettings.dashboardUrl,
      profileName: cliSettings.profile,
    };

    // Capture the ambient services the Management API stack needs, so the
    // lazily-built linked stack is fully self-provided and `resolve`'s R stays
    // `never` (handler tests can mock this resolver without wiring the whole
    // management runtime). None of these resolves an access token — only the
    // platform API layer does, and that is built only on the `--linked` branch.
    // `BunServices.layer` is included as a concrete layer (not a captured-value
    // `Layer.succeed`) because it provides FileSystem/Path, which have no single
    // tag to snapshot and which `managementApiRuntimeLayer` does not expose.
    const ambientLayer = Layer.mergeAll(
      Layer.succeed(ProfileFlag, yield* ProfileFlag),
      Layer.succeed(WorkdirFlag, yield* WorkdirFlag),
      Layer.succeed(OutputFlag, yield* OutputFlag),
      Layer.succeed(DebugFlag, yield* DebugFlag),
      // `linkedDbResolverRuntimeLayer`'s platform-API factory provides a DoH fetch layer that
      // reads `DnsResolverFlag`; snapshot it so the lazily built linked stack stays fully
      // self-provided (`resolve`'s R stays `never`).
      Layer.succeed(DnsResolverFlag, yield* DnsResolverFlag),
      Layer.succeed(RuntimeInfo, yield* RuntimeInfo),
      Layer.succeed(Analytics, yield* Analytics),
      Layer.succeed(TelemetryRuntime, yield* TelemetryRuntime),
      Layer.succeed(Tty, yield* Tty),
      Layer.succeed(Output, yield* Output),
      Layer.succeed(CommandTarget, commandTarget),
      // The per-command identity stitcher, shared with the linked stack's lazy platform-API
      // factory + linked-project cache. Provided to this layer by each command runtime.
      Layer.succeed(IdentityStitch, yield* IdentityStitch),
      // Optional (absent in handler tests): the lazy rebuild of
      // `commandSettingsLayer` reads it for explicit `--profile` detection, so
      // the nested resolution matches the outer layer's.
      Option.match(yield* Effect.serviceOption(CliArgs), {
        onNone: () => Layer.empty,
        onSome: (value) => Layer.succeed(CliArgs, value),
      }),
      BunServices.layer,
    );
    // Compile-time guard: if `linkedDbResolverRuntimeLayer`'s requirements ever
    // grow a service not captured above, this assignment fails to type-check (the
    // lazy `Effect.provide` in the `--linked` branch would otherwise leak that
    // service into `resolve`'s R and only surface as a runtime panic). Mirrors the
    // `_serviceCoverageCheck` pattern in `management-api-runtime.layer.ts`.
    const _ambientCoverageCheck: Layer.Layer<LinkedDbResolverRuntimeRequirements, never, never> =
      ambientLayer;
    void _ambientCoverageCheck;

    // `resolve`'s R is `never`, so capture StackApi at layer build.
    const stackDatabaseConn = stackLocalDatabaseConn.pipe(
      Effect.provideService(CommandSettings, cliSettings),
      Effect.provideService(StackApi, stackApi),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    // Honors `SUPABASE_SERVICES_HOSTNAME` / a tcp `DOCKER_HOST` in dev-container or remote-Docker
    // setups, defaulting to 127.0.0.1. Only env feeds the hostname, so the config file stays unread.
    const resolveLocalHost = Effect.gen(function* () {
      const hostConfig = yield* configValues
        .load({
          workdir: cliSettings.workdir,
          projectRef: Option.none(),
          ignoreConfigFile: true,
          tolerateInvalid: true,
        })
        .pipe(Effect.mapError(loadFailureToDbConfigError));
      return yield* getHostname(hostConfig).pipe(
        Effect.provideService(RuntimeInfo, runtimeInfo),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.catchTag("CliConfigLoadError", (error) =>
          Effect.fail(new Errors.DbConfigLoadError({ message: error.message })),
        ),
      );
    });

    const resolveDbUrl = (dbUrl: string, localHost: string, resolveVaultSecrets: boolean) =>
      Effect.gen(function* () {
        const tomlValues = yield* readDbToml(fs, path, cliSettings.workdir, undefined, {
          resolveVaultSecrets,
        });
        // The project `.env*` files populate the environment that the libpq `PG*` fallbacks
        // read. Layer the project env under the shell env (`loadProjectEnvValues` already excludes
        // shell-set keys, so the shell still wins) and feed it to the parser.
        const projectEnv = yield* loadProjectEnvValues(fs, path, cliSettings.workdir);
        const conn = yield* parseConnectionString(dbUrl, yield* layeredParseEnv(projectEnv)).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (conn === undefined) {
          return yield* new Errors.DbConfigParseUrlError({
            // Redact the password component before echoing the URL back
            // (CWE-209): a malformed `--db-url` often still carries a secret.
            message: `failed to parse connection string: ${redactConnectionString(dbUrl)}`,
          });
        }
        // A multi-host URL stays remote: local disables TLS for every fallback host as well.
        const singleHost = conn.fallbacks === undefined;
        const legacyLocal =
          singleHost &&
          isLocalDatabase(conn.host, localHost, conn.port, tomlValues.port, tomlValues.shadowPort);
        // The stack backend publishes its database on a runtime-assigned port rather than
        // `[db].port`, so a URL naming the running stack's SQL endpoint is local too.
        const stackConn =
          singleHost &&
          (yield* currentStackBackend).kind === "stack" &&
          mayBeStackDatabaseHost(conn.host, localHost)
            ? Option.getOrUndefined(yield* Effect.option(stackDatabaseConn))
            : undefined;
        const onStack = stackConn?.host === conn.host && stackConn.port === conn.port;
        const isLocal = legacyLocal || onStack;
        // A local direct URL fills an empty password from the local database's own
        // credentials, so a passwordless DSN like `postgresql://postgres@127.0.0.1:54322/postgres`
        // still authenticates.
        const localPassword = onStack ? stackConn.password : tomlValues.password;
        return {
          conn: isLocal && conn.password.length === 0 ? { ...conn, password: localPassword } : conn,
          isLocal,
        };
      });

    const resolveLocalStack = (localHost: string, resolveVaultSecrets: boolean) =>
      Effect.gen(function* () {
        const tomlValues = yield* readDbToml(fs, path, cliSettings.workdir, undefined, {
          resolveVaultSecrets,
        });
        const backend = yield* currentStackBackend;
        if (backend.kind === "stack") {
          return { conn: yield* stackDatabaseConn, isLocal: true };
        }
        return {
          conn: {
            host: localHost,
            port: tomlValues.port,
            user: "postgres",
            password: tomlValues.password,
            database: "postgres",
          },
          isLocal: true,
        };
      });

    // Validates the `[remotes.<ref>]`-merged config before any network work, so a config error is
    // never masked by the TCP probe, pooler or login-role calls. The linked-project cache GET is
    // left to each command's post-run hook so it stays after the command's own requests.
    const resolveLinkedConnection = (
      ref: string,
      options: {
        readonly dnsResolver: "native" | "https";
        readonly password: Option.Option<string>;
        readonly resolveVaultSecrets: boolean;
        readonly adHocProjectRef: boolean;
        readonly fetchPoolerFromApi: boolean;
        readonly hasPasswordFlag: boolean;
        readonly removeNetworkBans: boolean;
      },
    ) =>
      Effect.gen(function* () {
        yield* readDbToml(fs, path, cliSettings.workdir, ref, {
          resolveVaultSecrets: options.resolveVaultSecrets,
        });
        return yield* resolveLinkedConn(
          ref,
          cliSettings.workdir,
          cliSettings.projectHost,
          cliSettings.poolerHost,
          options.dnsResolver,
          options.password,
          {
            adHocProjectRef: options.adHocProjectRef,
            resolveVaultSecrets: options.resolveVaultSecrets,
            fetchPoolerFromApi: options.fetchPoolerFromApi,
            hasPasswordFlag: options.hasPasswordFlag,
            removeNetworkBans: options.removeNetworkBans,
          },
        );
      });

    // Built per linked call so `--local`/`--db-url` never touch it; the platform API factory
    // resolves the access token only when a temp role is minted, so `--password` stays auth-free.
    const withLinkedRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            linkedDbResolverRuntimeLayer(["test", "db"]).pipe(Layer.provide(ambientLayer)),
            localAmbientServices,
          ),
        ),
      );

    const resolve = (flags: DbConfigFlags) =>
      Effect.gen(function* () {
        yield* rejectPasswordWithDirectTarget(flags.connType, flags.password);
        const resolveVaultSecrets = flags.resolveVaultSecrets ?? true;
        // Config is read per branch, not unconditionally up front: the linked branch resolves
        // the ref first and reads the `[remotes.<ref>]`-merged config. A base read here would
        // validate base config (db.major_version, deno_version, …) before the ref is known,
        // failing a linked run that should succeed once the ref is known. Only
        // `--db-url`/`--local` read base config, since neither merges a remote block.
        const localHost = yield* resolveLocalHost;

        // --db-url (direct) takes precedence.
        if (flags.connType === "db-url" && Option.isSome(flags.dbUrl)) {
          return yield* resolveDbUrl(flags.dbUrl.value, localHost, resolveVaultSecrets);
        }

        if (flags.connType === "linked") {
          const linked = yield* withLinkedRuntime(
            Effect.gen(function* () {
              const projectRef = yield* ProjectRefResolver;
              // Load-or-fail with no prompt: use `loadProjectRef` (not the soft
              // `resolveOptional`, which swallows a read error to `None`) — an unlinked workdir
              // fails with a not-linked error, a bad ref with the invalid-ref error, and an
              // unreadable ref file surfaces the filesystem problem, for every caller of this
              // resolver (`test db --linked`, dump, declarative).
              const ref = yield* projectRef.loadProjectRef(flags.linkedProjectRef ?? Option.none());
              const conn = yield* resolveLinkedConnection(ref, {
                dnsResolver: flags.dnsResolver,
                password: passwordFlag(flags.password),
                resolveVaultSecrets,
                adHocProjectRef: flags.adHocProjectRef ?? false,
                // An explicit ref (the eight `db` commands' `--project-ref`, or
                // `gen types --project-id`) independently unlocks the Management API
                // pooler fetch, regardless of `adHocProjectRef`'s saved-URL semantics
                // — see `DbConfigFlags.linkedProjectRef`'s doc comment.
                fetchPoolerFromApi: Option.isSome(flags.linkedProjectRef ?? Option.none()),
                hasPasswordFlag: flags.password !== undefined,
                removeNetworkBans: true,
              });
              return { conn, ref };
            }),
          );
          // Surface the resolved ref so the caller can re-read config with a matching
          // `[remotes.<ref>]` override applied (merged into the linked config).
          return { conn: linked.conn, isLocal: false, ref: Option.some(linked.ref) };
        }

        return yield* resolveLocalStack(localHost, resolveVaultSecrets);
      });

    const resolveConnection = (input: DbConnectionInput) =>
      Effect.gen(function* () {
        const { target } = input;
        if (target.kind !== "linked") {
          yield* rejectTargetPassword(target.kind, input.password);
        }
        const resolveVaultSecrets = input.resolveVaultSecrets ?? true;
        if (target.kind === "linked") {
          const conn = yield* withLinkedRuntime(
            resolveLinkedConnection(target.ref, {
              dnsResolver: input.dnsResolver,
              password: input.password,
              resolveVaultSecrets,
              adHocProjectRef: !target.matchesLinkedRef,
              fetchPoolerFromApi: target.source === "flag",
              hasPasswordFlag: input.hasPasswordFlag ?? false,
              removeNetworkBans: Option.isSome(input.networkBanRemoval),
            }),
          );
          return { conn, isLocal: false, ref: Option.some(target.ref), target };
        }
        const localHost = yield* resolveLocalHost;
        if (target.kind === "db-url") {
          const resolved = yield* resolveDbUrl(
            Redacted.value(target.url),
            localHost,
            resolveVaultSecrets,
          );
          yield* commandTarget.announce(renderDbUrlTarget(resolved.conn.host, resolved.conn.port));
          return { ...resolved, target };
        }
        const resolved = yield* resolveLocalStack(localHost, resolveVaultSecrets);
        yield* commandTarget.announce(renderLocalTarget(resolved.conn.host, resolved.conn.port));
        return { ...resolved, target };
      });

    // When a linked dump's pg_dump container fails with an IPv6 connectivity error (the direct
    // host is reachable from the CLI process but not from inside Docker), it resolves the
    // project's IPv4 transaction pooler and retries once. This exposes that pooler resolution
    // for the dump handler to invoke on demand. Returns `None` when the path is not
    // pooler-eligible (`--linked` only) or no pooler URL is configured, so the caller keeps the
    // original container error.
    const resolvePoolerFallback = (flags: DbConfigFlags) =>
      Effect.gen(function* () {
        if (flags.connType !== "linked") return Option.none<PgConnInput>();
        return yield* Effect.gen(function* () {
          const projectRef = yield* ProjectRefResolver;
          const refOpt = yield* projectRef.resolveOptional(flags.linkedProjectRef ?? Option.none());
          if (Option.isNone(refOpt)) return Option.none<PgConnInput>();
          const ref = refOpt.value;
          if (!PROJECT_REF_PATTERN.test(ref)) return Option.none<PgConnInput>();
          const adHocProjectRef = flags.adHocProjectRef ?? false;
          const password = yield* resolveLinkedPassword(
            ref,
            cliSettings.workdir,
            passwordFlag(flags.password),
            flags.password !== undefined,
          );
          // Container-fallback: fetch the primary pooler config from the Management API when
          // no `.temp/pooler-url` is saved.
          return yield* resolvePoolerConn(
            ref,
            cliSettings.workdir,
            cliSettings.poolerHost,
            flags.dnsResolver,
            password,
            true,
            adHocProjectRef,
            flags.resolveVaultSecrets ?? true,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              linkedDbResolverRuntimeLayer(["db", "dump"]).pipe(Layer.provide(ambientLayer)),
              localAmbientServices,
            ),
          ),
        );
      });

    // Attach the connect-failure suggestion context to every resolved connection in one place,
    // so each connecting command inherits the hint without per-call-site wiring.
    const withSuggestion = (conn: PgConnInput): PgConnInput => ({
      ...conn,
      suggestionContext,
    });
    return DbConfigResolver.of({
      resolve: (flags) =>
        resolve(flags).pipe(
          Effect.provideService(CliConfigValues, configValues),
          Effect.tap((r) => Effect.annotateCurrentSpan("db.is_local", r.isLocal)),
          Effect.map((r) => ({ ...r, conn: withSuggestion(r.conn) })),
          Effect.withSpan("DbConfig.resolve", {
            attributes: { "db.conn_type": flags.connType ?? "local" },
          }),
        ),
      resolveConnection: (input) =>
        resolveConnection(input).pipe(
          Effect.provideService(CliConfigValues, configValues),
          Effect.tap((r) => Effect.annotateCurrentSpan("db.is_local", r.isLocal)),
          Effect.map((r) => ({ ...r, conn: withSuggestion(r.conn) })),
          Effect.withSpan("DbConfig.resolveConnection", {
            attributes: { "db.conn_type": input.target.kind },
          }),
        ),
      resolvePoolerFallback: (flags) =>
        resolvePoolerFallback(flags).pipe(
          Effect.provideService(CliConfigValues, configValues),
          Effect.tap((pooler) =>
            Effect.annotateCurrentSpan("db.pooler.found", Option.isSome(pooler)),
          ),
          Effect.map(Option.map(withSuggestion)),
          Effect.withSpan("DbConfig.resolvePoolerFallback", {
            attributes: { "db.conn_type": flags.connType ?? "local" },
          }),
        ),
    });
  }),
);

export const dbConfigLayer = dbConfigResolverLayer.pipe(Layer.provide(stackApiLayer));
