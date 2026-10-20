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
import type { DbConnectionInput } from "./db-config.types.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { getHostname } from "./hostname.ts";
import { mapHttpError } from "./http-errors.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { stackLocalDatabaseConn } from "./stack-local-database.ts";
import { block, type OperationEntry } from "./command-permissions/model.ts";
import { renderDbUrlTarget, renderLocalTarget } from "./target/target-identity.ts";
import { isCheckoutLinked } from "../shared/config/temp-paths.ts";
import { rejectTargetPassword } from "./target/target-password.ts";

const loginRoleEntry = {
  operationId: "v1-create-login-role",
  kind: "required",
  when: [{ flag: "password", present: false }],
  context:
    "no database password supplied by the command (an empty one still mints a login role) or set in SUPABASE_DB_PASSWORD or the project .env (an ad-hoc project ref ignores the last two)",
} as const satisfies Omit<OperationEntry, "source">;

const poolerConfigEntry = {
  operationId: "v1-get-pooler-config",
  kind: "required",
  context:
    "the direct database host is unreachable (IPv4-only network) and there is no usable saved supabase/.temp/pooler-url",
} as const satisfies Omit<OperationEntry, "source">;

const networkBanEntries = [
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
] as const satisfies ReadonlyArray<Omit<OperationEntry, "source">>;

const linkedEntries: ReadonlyArray<Omit<OperationEntry, "source">> = [
  loginRoleEntry,
  poolerConfigEntry,
  ...networkBanEntries,
  ...projectRefPicker.operations,
];

/**
 * The same calls as {@link dbConfig} without its target condition, for a command that reaches the
 * linked path some other way, such as `db diff --from linked`.
 */
export const dbConfigLinked = block("db-config", linkedEntries);

/** The calls {@link dbConfigLinked} makes for a project a non-selector flag names, such as `db diff --from=<ref>`. */
export const dbConfigNamedProject = block("db-config", [
  loginRoleEntry,
  poolerConfigEntry,
  ...networkBanEntries,
]);

/**
 * `DbConfigResolver` on the linked path; `--local` and `--db-url` make no API calls. The container
 * retry that `db dump` and `db pull` run is {@link dbConfigPoolerFallback}.
 */
export const dbConfig = block(
  "db-config",
  linkedEntries.map((entry) => ({
    ...entry,
    when: [{ dbTarget: ["linked" as const] }, ...(entry.when ?? [])],
  })),
);

const poolerFallbackEntries: ReadonlyArray<Omit<OperationEntry, "source">> = [
  {
    operationId: "v1-get-pooler-config",
    kind: "required",
    context:
      "the command's database work fails with an IPv6 connectivity error against the direct database host, and there is no usable saved supabase/.temp/pooler-url",
  },
  {
    operationId: "v1-create-login-role",
    kind: "required",
    when: [{ flag: "password", present: false }],
    context:
      "the same retry, and no database password supplied by the command (an empty one still mints a login role) or set in SUPABASE_DB_PASSWORD or the project .env (an ad-hoc project ref ignores the last two)",
  },
  {
    operationId: "v1-list-all-network-bans",
    kind: "best-effort",
    when: [{ flag: "password", present: false }],
    context: "the same retry, after three failed attempts to connect as the temporary login role",
  },
  {
    operationId: "v1-delete-network-bans",
    kind: "best-effort",
    when: [{ flag: "password", present: false }],
    context: "the same retry, after three failed attempts to connect as the temporary login role",
  },
];

/**
 * The same calls as {@link dbConfigPoolerFallback} without its target condition, for `gen types`,
 * which picks its target from flag values.
 */
export const dbConfigPoolerFallbackLinked = block(
  "db-config-pooler-fallback",
  poolerFallbackEntries,
);

/**
 * `DbConfigResolver.resolvePoolerFallback`, the pooler retry after a linked dump, declarative export
 * or pull diff fails with an IPv6 connectivity error against a direct host the CLI could reach.
 */
export const dbConfigPoolerFallback = block(
  "db-config-pooler-fallback",
  poolerFallbackEntries.map((entry) => ({
    ...entry,
    when: [{ dbTarget: ["linked" as const] }, ...(entry.when ?? [])],
  })),
);

/** Only a `--yes`-sourced approval may clear bans; a prompt answer never does, since removal clears every listed address. */
const canRemoveNetworkBans = (input: DbConnectionInput): boolean =>
  Option.exists(input.networkBanRemoval, (approval) => approval.via === "yes");

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
// `CommandPlatformApi` stack), so the access token is resolved only when a call needs it: this
// mint or the pooler-config fallback. `--local`/`--db-url` never build this layer at all.
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

const listBans = Effect.fnUntraced(function* (ref: string) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const bans = yield* api.v1.listAllNetworkBans({ ref }).pipe(Effect.catch(listBansErrorMapper));
  return bans.banned_ipv4_addresses;
});

const removeBans = Effect.fnUntraced(function* (ref: string, addrs: ReadonlyArray<string>) {
  const output = yield* Output;
  const api = yield* (yield* CommandPlatformApiFactory).make;
  yield* output.raw(`Removing network bans (${addrs.join(", ")})...\n`, "stderr");
  yield* api.v1
    .deleteNetworkBans({ ref, ipv4_addresses: [...addrs], requester_ip: false })
    .pipe(Effect.catch(unbanErrorMapper));
});

const networkBannedError = (ref: string, addrs: ReadonlyArray<string>) =>
  new Errors.LinkedDbNetworkBannedError({
    message: `Network bans (${addrs.join(", ")}) may be blocking the connection. Removing them clears every listed address, so it needs --yes.`,
    suggestion: `Re-run with --yes to remove them, or run supabase network-bans remove --db-unban-ip ${addrs.join(",")} --experimental --yes --remote=${ref}`,
  });

// Verify-connect with backoff while the pooler refreshes the temp password. From attempt 3 on, look
// for network bans on the project: with approval they are removed, without it the last listing is
// reported if the retries run out.
const waitForTempRole = Effect.fn("DbConfig.waitForTempRole")(function* (
  ref: string,
  conn: PgConnInput,
  dnsResolver: "native" | "https",
  removeNetworkBans: boolean,
) {
  const dbConn = yield* DbConnection;
  const debug = yield* DebugLogger;
  const attempt = (
    n: number,
    listedBans: ReadonlyArray<string>,
  ): Effect.Effect<void, DbConfigError, CommandPlatformApiFactory | Output> =>
    // The temp-role probe always targets the remote Supavisor pooler, so it connects with TLS
    // and honors `--dns-resolver`.
    Effect.scoped(dbConn.connect(conn, { isLocal: false, dnsResolver }).pipe(Effect.asVoid)).pipe(
      Effect.ensuring(Effect.annotateCurrentSpan("retry.attempt_count", n)),
      Effect.catch((cause) => {
        // 8 retries after the initial attempt allows 9 total attempts. `n` is 1-based, so give
        // up only after attempt 9 (`n > MAX_RETRIES`), not at attempt 8.
        if (n > MAX_RETRIES) {
          return Effect.fail(
            listedBans.length > 0
              ? networkBannedError(ref, listedBans)
              : new Errors.DbConfigConnectTempRoleError({
                  message: `failed to connect as temp role: ${cause.message}`,
                  suggestion: SUGGEST_ENV_VAR,
                }),
          );
        }
        // Deterministic backoff rather than jittered, since jitter only matters under concurrent
        // pooler refreshes.
        const delayMs = Math.min(
          Duration.toMillis(BACKOFF_INITIAL) * 1.5 ** (n - 1),
          Duration.toMillis(BACKOFF_MAX),
        );
        return Effect.gen(function* () {
          // A transient ban-list/unban failure must not propagate out of the retry loop; log it
          // to --debug, then discard.
          const bans =
            n < 3
              ? listedBans
              : yield* listBans(ref).pipe(
                  Effect.flatMap((addrs) =>
                    addrs.length > 0 && removeNetworkBans
                      ? removeBans(ref, addrs).pipe(Effect.as([]))
                      : Effect.succeed(addrs),
                  ),
                  Effect.catch((banError) =>
                    debug.debug(banError.message).pipe(Effect.as(listedBans)),
                  ),
                );
          yield* debug.debug(`Retry (${n}/${MAX_RETRIES}): ${cause.message}`);
          yield* Effect.sleep(Duration.millis(delayMs));
          return yield* attempt(n + 1, bans);
        });
      }),
    );
  return yield* attempt(1, []);
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

/** The API's primary pooler URL; any failure, a missing access token included, means none. */
const fetchApiPoolerUrl = Effect.fn("DbConfig.fetchApiPoolerUrl")(
  function* (ref: string) {
    const api = yield* (yield* CommandPlatformApiFactory).make;
    const configs = yield* api.v1.getPoolerConfig({ ref });
    return configs.find((config) => config.database_type === "PRIMARY")?.connection_string;
  },
  Effect.orElseSucceed(() => undefined),
);

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
  fetchFromApi = false,
  // For an ad-hoc `--project-ref` the saved `.temp/pooler-url` belongs to the
  // (possibly different) linked workdir, so ignore it and resolve the pooler for
  // `ref` from the Management API instead.
  ignoreSavedUrl = false,
  resolveVaultSecrets = true,
  removeNetworkBans: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Linked-path read: merge the `[remotes.<ref>]` override, so this matches the ref-aware read
  // on the main linked branch rather than validating base config. For an ad-hoc `--project-ref`,
  // skip the saved workdir pooler URL because it belongs to the linked project, not necessarily
  // the explicit ref.
  const tomlValues = yield* readDbToml(fs, path, workdir, ref, {
    resolveVaultSecrets,
  });
  let connectionString = ignoreSavedUrl
    ? undefined
    : Option.getOrUndefined(tomlValues.poolerConnectionString);
  if (connectionString === undefined) {
    if (!fetchFromApi) return Option.none<PgConnInput>();
    connectionString = yield* fetchApiPoolerUrl(ref);
    if (connectionString === undefined) return Option.none<PgConnInput>();
  }
  let pooler = Option.none<PgConnInput>();
  if (connectionString !== undefined) {
    pooler = yield* poolerConfigFrom(ref, connectionString, poolerHost);
  }
  if (Option.isNone(pooler) && fetchFromApi) {
    const apiUrl = yield* fetchApiPoolerUrl(ref);
    if (apiUrl !== undefined) {
      pooler = yield* poolerConfigFrom(ref, apiUrl, poolerHost);
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
    /** Whether the temp-role retry may clear listed network bans; only a `--yes`-sourced approval sets it. */
    readonly removeNetworkBans: boolean;
    readonly adHocProjectRef?: boolean;
    readonly resolveVaultSecrets?: boolean;
    /**
     * Requests the Management API pooler-config fetch on an IPv4-only network independent of
     * `adHocProjectRef`'s saved-URL semantics, so a workdir with no usable saved pooler URL still
     * reaches the primary pooler config instead of dead-ending in the "run supabase link" IPv6 error.
     */
    readonly fetchPoolerFromApi?: boolean;
    /** Whether the calling command binds `--password`, so the withheld-password notice can name it. */
    readonly hasPasswordFlag?: boolean;
  },
) {
  const {
    adHocProjectRef = false,
    resolveVaultSecrets = true,
    fetchPoolerFromApi = false,
    hasPasswordFlag = false,
    removeNetworkBans,
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

  // Direct host unreachable (IPv6-only network) → try the pooler. An ad-hoc ref skips the saved
  // pooler URL, which belongs to the linked project; with `fetchPoolerFromApi`, either case falls
  // back to the Management API's pooler config when an access token is available.
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
      suggestion: adHocProjectRef
        ? "Pass the project's connection pooler URL with --remote=<pooler db-url> to connect over IPv4."
        : `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
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
    // services into `resolveConnection`/`resolvePoolerFallback`'s R (the interface promises `never`), so
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
    // lazily-built linked stack is fully self-provided and `resolveConnection`'s R stays
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
      // self-provided (`resolveConnection`'s R stays `never`).
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
    // service into `resolveConnection`'s R and only surface as a runtime panic). Mirrors the
    // `_serviceCoverageCheck` pattern in `management-api-runtime.layer.ts`.
    const _ambientCoverageCheck: Layer.Layer<LinkedDbResolverRuntimeRequirements, never, never> =
      ambientLayer;
    void _ambientCoverageCheck;

    // `resolveConnection`'s R is `never`, so capture StackApi at layer build.
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
            fetchPoolerFromApi: true,
            hasPasswordFlag: options.hasPasswordFlag,
            removeNetworkBans: options.removeNetworkBans,
          },
        );
      });

    // Built per linked call so `--local`/`--db-url` never touch it; the platform API factory
    // resolves the access token only when a call needs it, and `--password` needs none.
    const withLinkedRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            linkedDbResolverRuntimeLayer(["test", "db"]).pipe(Layer.provide(ambientLayer)),
            localAmbientServices,
          ),
        ),
      );

    const resolveConnection = (input: DbConnectionInput) =>
      Effect.gen(function* () {
        const { target } = input;
        const linkedCheckout =
          target.kind === "local" &&
          (yield* isCheckoutLinked(fs, path, cliSettings.workdir, cliSettings.projectId));
        if (target.kind !== "linked") {
          yield* rejectTargetPassword(target.kind, input.password, linkedCheckout);
        }
        const resolveVaultSecrets = input.resolveVaultSecrets ?? true;
        if (target.kind === "linked") {
          const conn = yield* withLinkedRuntime(
            resolveLinkedConnection(target.ref, {
              dnsResolver: input.dnsResolver,
              password: input.password,
              resolveVaultSecrets,
              adHocProjectRef: !target.matchesLinkedRef,
              hasPasswordFlag: input.hasPasswordFlag ?? false,
              removeNetworkBans: canRemoveNetworkBans(input),
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
        return {
          ...resolved,
          conn: linkedCheckout
            ? { ...resolved.conn, suggestionContext: { ...suggestionContext, linkedCheckout } }
            : resolved.conn,
          target,
        };
      });

    // When a linked dump's pg_dump container fails with an IPv6 connectivity error (the direct
    // host is reachable from the CLI process but not from inside Docker), it resolves the
    // project's IPv4 transaction pooler and retries once. Returns `None` for a local or `--db-url`
    // target or when no pooler URL is configured, so the caller keeps the original container error.
    const resolvePoolerFallback = (input: DbConnectionInput) =>
      Effect.gen(function* () {
        const { target } = input;
        if (target.kind !== "linked") return Option.none<PgConnInput>();
        return yield* Effect.gen(function* () {
          const password = yield* resolveLinkedPassword(
            target.ref,
            cliSettings.workdir,
            input.password,
            input.hasPasswordFlag ?? false,
          );
          // Container-fallback: fetch the primary pooler config from the Management API when
          // no `.temp/pooler-url` is saved.
          return yield* resolvePoolerConn(
            target.ref,
            cliSettings.workdir,
            cliSettings.poolerHost,
            input.dnsResolver,
            password,
            true,
            !target.matchesLinkedRef,
            input.resolveVaultSecrets ?? true,
            canRemoveNetworkBans(input),
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
      suggestionContext: conn.suggestionContext ?? suggestionContext,
    });
    return DbConfigResolver.of({
      resolveConnection: (input) =>
        resolveConnection(input).pipe(
          Effect.provideService(CliConfigValues, configValues),
          Effect.tap((r) => Effect.annotateCurrentSpan("db.is_local", r.isLocal)),
          Effect.map((r) => ({ ...r, conn: withSuggestion(r.conn) })),
          Effect.withSpan("DbConfig.resolveConnection", {
            attributes: { "db.conn_type": input.target.kind },
          }),
        ),
      resolvePoolerFallback: (input) =>
        resolvePoolerFallback(input).pipe(
          Effect.provideService(CliConfigValues, configValues),
          Effect.tap((pooler) =>
            Effect.annotateCurrentSpan("db.pooler.found", Option.isSome(pooler)),
          ),
          Effect.map(Option.map(withSuggestion)),
          Effect.withSpan("DbConfig.resolvePoolerFallback", {
            attributes: { "db.conn_type": input.target.kind },
          }),
        ),
    });
  }),
);

export const dbConfigLayer = dbConfigResolverLayer.pipe(Layer.provide(stackApiLayer));
