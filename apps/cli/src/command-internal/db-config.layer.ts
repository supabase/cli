import * as net from "node:net";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { ProjectRefResolver, PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
} from "./global-flags.ts";
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
import { loadProjectEnv, readDbToml } from "./db-config.toml-read.ts";
import type { DbConfigFlags } from "./db-config.types.ts";
import { DebugLogger } from "./debug-logger.service.ts";
import { getHostname } from "./hostname.ts";
import { mapHttpError } from "./http-errors.ts";
import { currentStackBackend } from "../commands/experimental/stack/stack-backend.ts";
import { StackApi, stackApiLayer } from "../commands/experimental/stack/stack.shared.ts";
import { stackLocalDatabaseConn } from "./stack-local-database.ts";

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
  );

// POST /v1/projects/{ref}/cli/login-role → mint a temporary postgres role. The Management API
// client is built lazily via `CommandPlatformApiFactory.make` (not the eager
// `CommandPlatformApi` stack), so the access token is resolved only here — when a temp role is
// actually minted. `--linked --password` returns before reaching this, so it stays auth-free;
// `--local`/`--db-url` never build this layer at all.
const initLoginRole = Effect.fnUntraced(function* (ref: string, conn: PgConnInput) {
  const output = yield* Output;
  const api = yield* (yield* CommandPlatformApiFactory).make;
  // Written to stderr unconditionally (not gated on --debug).
  yield* output.raw("Initialising login role...\n", "stderr");
  const role = yield* api.v1
    .createLoginRole({ ref, read_only: false })
    .pipe(Effect.catch(loginRoleErrorMapper));
  return { ...conn, user: role.role, password: role.password };
});

const listAndUnban = Effect.fnUntraced(function* (ref: string) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const bans = yield* api.v1.listAllNetworkBans({ ref }).pipe(Effect.catch(listBansErrorMapper));
  const addrs = bans.banned_ipv4_addresses;
  if (addrs.length === 0) return;
  yield* api.v1
    .deleteNetworkBans({ ref, ipv4_addresses: [...addrs], requester_ip: false })
    .pipe(Effect.catch(unbanErrorMapper));
});

// Verify-connect with backoff while the pooler refreshes the temp password. On attempt ≥ 3,
// clear any network ban on the requester.
const waitForTempRole = Effect.fnUntraced(function* (
  ref: string,
  conn: PgConnInput,
  dnsResolver: "native" | "https",
) {
  const dbConn = yield* DbConnection;
  const debug = yield* DebugLogger;
  const attempt = (n: number): Effect.Effect<void, DbConfigError, CommandPlatformApiFactory> =>
    // The temp-role probe always targets the remote Supavisor pooler, so it connects with TLS
    // and honors `--dns-resolver`.
    Effect.scoped(dbConn.connect(conn, { isLocal: false, dnsResolver }).pipe(Effect.asVoid)).pipe(
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
        const unban = n >= 3 ? listAndUnban(ref) : Effect.void;
        const delayMs = Math.min(
          Duration.toMillis(BACKOFF_INITIAL) * 1.5 ** (n - 1),
          Duration.toMillis(BACKOFF_MAX),
        );
        return Effect.gen(function* () {
          // A transient ban-list/unban failure must not propagate out of the retry loop; log
          // it to --debug, then discard.
          yield* unban.pipe(
            Effect.tapError((banError) => debug.debug(banError.message)),
            Effect.ignore,
          );
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
  const result = poolerConfigFromConnectionString(ref, connectionString, poolerHost);
  if (result._tag === "ok") return Option.some(result.conn);
  yield* debug.debug(result.reason);
  return Option.none();
});

// Resolve the DB password with this precedence: `--password` flag → `SUPABASE_DB_PASSWORD`
// shell env → project `.env*` value. `loadProjectEnv` already excludes shell-set keys, so the
// shell value still wins over the file. `workdir` is an explicit parameter (never
// `CommandSettings.workdir`) so callers whose real workdir has diverged from that cwd-walked
// value (e.g. `bootstrap`, after its own `process.chdir`) still resolve against the correct
// directory.
const resolveDbPassword = Effect.fnUntraced(function* (
  passwordFlag: Option.Option<string>,
  workdir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  return (
    Option.getOrUndefined(passwordFlag) ??
    process.env["SUPABASE_DB_PASSWORD"] ??
    projectEnv["SUPABASE_DB_PASSWORD"] ??
    ""
  );
});

/**
 * Resolve the IPv4 transaction pooler connection for `ref`. Returns `None` when no pooler URL is
 * configured or it fails validation, so the caller can keep the original error. With a password,
 * uses it directly; without one, mints a temp login role and verify-connects through the pooler.
 *
 * `workdir`/`poolerHost` are explicit parameters (see {@link resolveDbPassword}).
 */
const resolvePoolerConn = Effect.fnUntraced(function* (
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
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const debug = yield* DebugLogger;
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
  if (password.length > 0) {
    yield* debug.debug("Using database password from env var...");
    return Option.some({ ...poolerConn, password });
  }
  // Mint a temp role; preserve Supavisor's `<user>.<ref>` tenant suffix.
  const originalUser = poolerConn.user;
  const withRole = yield* initLoginRole(ref, poolerConn);
  const finalUser = originalUser.endsWith(`.${ref}`) ? `${withRole.user}.${ref}` : withRole.user;
  const tempConn = { ...withRole, user: finalUser };
  yield* waitForTempRole(ref, tempConn, dnsResolver);
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
export const resolveLinkedConn = Effect.fnUntraced(function* (
  ref: string,
  workdir: string,
  projectHost: string,
  poolerHost: string,
  dnsResolver: "native" | "https",
  passwordFlag: Option.Option<string>,
  options: {
    readonly adHocProjectRef?: boolean;
    readonly resolveVaultSecrets?: boolean;
    /**
     * Requests the Management API pooler-config fetch on an IPv4-only network
     * independent of `adHocProjectRef`'s credential/saved-URL semantics — see
     * `DbConfigFlags.linkedProjectRef`'s doc comment. Set when the caller
     * supplied an explicit ref (`--project-ref`/`--project-id`) rather than
     * falling back to `.temp/project-ref`, so an unlinked or mismatched-tenant
     * workdir still reaches the primary pooler config instead of dead-ending in
     * the "run supabase link" IPv6 error.
     */
    readonly fetchPoolerFromApi?: boolean;
  } = {},
) {
  const {
    adHocProjectRef = false,
    resolveVaultSecrets = true,
    fetchPoolerFromApi = false,
  } = options;
  const debug = yield* DebugLogger;
  // Read lazily (per invocation) rather than at layer build, so tests and
  // env-substitution see the current value. For an ad-hoc `--project-id` ref,
  // honor only an explicit `--password` flag and ignore the ambient
  // `SUPABASE_DB_PASSWORD` (which belongs to the current workdir, not this ref),
  // so we always mint a temporary login role instead of leaking it.
  const dbPassword = adHocProjectRef
    ? (Option.getOrUndefined(passwordFlag) ?? "")
    : yield* resolveDbPassword(passwordFlag, workdir);
  const host = `db.${ref}.${projectHost}`;
  const base: PgConnInput = {
    host,
    port: DIRECT_PORT,
    user: "postgres",
    password: dbPassword,
    database: "postgres",
  };

  const reachable = yield* tcpReachable(host, DIRECT_PORT);
  if (reachable) {
    if (base.password.length > 0) {
      yield* debug.debug("Using database password from env var...");
      return base;
    }
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
  );
  if (Option.isNone(poolerConn)) {
    return yield* Effect.fail(
      new Errors.DbConfigIpv6Error({
        message: "IPv6 is not supported on your current network",
        suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
      }),
    );
  }
  return poolerConn.value;
});

export const dbConfigResolverLayer = Layer.effect(
  DbConfigResolver,
  Effect.gen(function* () {
    const cliSettings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const debug = yield* DebugLogger;
    const output = yield* Output;
    const dbConn = yield* DbConnection;
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

    const resolve = (flags: DbConfigFlags) =>
      Effect.gen(function* () {
        const resolveVaultSecrets = flags.resolveVaultSecrets ?? true;
        // Config is read per branch, not unconditionally up front: the linked branch resolves
        // the ref first and reads the `[remotes.<ref>]`-merged config (below). A base read here
        // would validate base config (db.major_version, deno_version, …) before the ref is
        // known, failing a linked run that should succeed once the ref is known. Only
        // `--db-url`/`--local` read base config, since neither merges a remote block.
        // Honors `SUPABASE_SERVICES_HOSTNAME` / a tcp `DOCKER_HOST` in dev-container or
        // remote-Docker setups, defaulting to 127.0.0.1.
        const localHost = getHostname();

        // --db-url (direct) takes precedence.
        if (flags.connType === "db-url" && Option.isSome(flags.dbUrl)) {
          const tomlValues = yield* readDbToml(fs, path, cliSettings.workdir, undefined, {
            resolveVaultSecrets,
          });
          // The project `.env*` files populate the environment that the libpq `PG*` fallbacks
          // read. Layer the project env under the shell env (`loadProjectEnv` already excludes
          // shell-set keys, so the shell still wins) and feed it to the parser.
          const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
          const conn = parseConnectionString(flags.dbUrl.value, layeredParseEnv(projectEnv));
          if (conn === undefined) {
            return yield* Effect.fail(
              new Errors.DbConfigParseUrlError({
                // Redact the password component before echoing the URL back
                // (CWE-209): a malformed `--db-url` often still carries a secret.
                message: `failed to parse connection string: ${redactConnectionString(flags.dbUrl.value)}`,
              }),
            );
          }
          const isLocal = isLocalDatabase(
            conn.host,
            localHost,
            conn.port,
            tomlValues.port,
            tomlValues.shadowPort,
          );
          // A local direct URL fills an empty password from the local `[db].password` config,
          // so a passwordless local DSN like `postgresql://postgres@127.0.0.1:54322/postgres`
          // still authenticates.
          return {
            conn:
              isLocal && conn.password.length === 0
                ? { ...conn, password: tomlValues.password }
                : conn,
            isLocal,
          };
        }

        // --linked. The lazy Management API runtime (project-ref resolver + lazy platform API
        // factory) is provided here at runtime so it is only built on this branch —
        // `--local`/`--db-url` never touch it. The factory resolves the access token only on
        // first use (minting a temp role), so a `--linked --password` invocation stays
        // auth-free.
        if (flags.connType === "linked") {
          const linked = yield* Effect.gen(function* () {
            const projectRef = yield* ProjectRefResolver;
            // Load-or-fail with no prompt: use `loadProjectRef` (not the soft
            // `resolveOptional`, which swallows a read error to `None`) — an unlinked workdir
            // fails with a not-linked error, a bad ref with the invalid-ref error, and an
            // unreadable ref file surfaces the filesystem problem, for every caller of this
            // resolver (`test db --linked`, dump, declarative).
            const ref = yield* projectRef.loadProjectRef(flags.linkedProjectRef ?? Option.none());
            // The `[remotes.<ref>]`-merged config (e.g. an unsupported remote
            // `db.major_version`/`edge_runtime.deno_version`) is validated as a pure config
            // error before any network work. The base read in `resolve` above only validates
            // remote `project_id`s, not the ref-merged block — so validate the merged config
            // here, before the TCP probe / pooler / temp-role Management API calls, rather than
            // letting those mask (or run side effects ahead of) the real config error.
            yield* readDbToml(fs, path, cliSettings.workdir, ref, {
              resolveVaultSecrets,
            });
            const resolved = yield* resolveLinkedConn(
              ref,
              cliSettings.workdir,
              cliSettings.projectHost,
              cliSettings.poolerHost,
              flags.dnsResolver,
              flags.password ?? Option.none(),
              {
                adHocProjectRef: flags.adHocProjectRef ?? false,
                resolveVaultSecrets,
                // An explicit ref (the eight `db` commands' `--project-ref`, or
                // `gen types --project-id`) independently unlocks the Management API
                // pooler fetch, regardless of `adHocProjectRef`'s credential semantics
                // — see `DbConfigFlags.linkedProjectRef`'s doc comment.
                fetchPoolerFromApi: Option.isSome(flags.linkedProjectRef ?? Option.none()),
              },
            );
            // The linked-project telemetry cache (GET /v1/projects/{ref}) is not issued here:
            // it's cached in a post-run hook, after the command's own API calls, so each linked
            // command owns that GET in its post-run finalizer. Issuing it mid-resolve would
            // reorder the request log ahead of the command's GETs.
            return { conn: resolved, ref };
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                linkedDbResolverRuntimeLayer(["test", "db"]).pipe(Layer.provide(ambientLayer)),
                localAmbientServices,
              ),
            ),
          );
          // Surface the resolved ref so the caller can re-read config with a matching
          // `[remotes.<ref>]` override applied (merged into the linked config).
          return { conn: linked.conn, isLocal: false, ref: Option.some(linked.ref) };
        }

        // --local (default).
        const tomlValues = yield* readDbToml(fs, path, cliSettings.workdir, undefined, {
          resolveVaultSecrets,
        });
        const backend = yield* currentStackBackend;
        if (backend.kind === "stack") {
          // `resolve`'s R is `never`, so capture StackApi at layer build.
          const conn = yield* stackLocalDatabaseConn.pipe(
            Effect.provideService(CommandSettings, cliSettings),
            Effect.provideService(StackApi, stackApi),
          );
          return { conn, isLocal: true };
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
          const password = adHocProjectRef
            ? (Option.getOrUndefined(flags.password ?? Option.none()) ?? "")
            : yield* resolveDbPassword(flags.password ?? Option.none(), cliSettings.workdir);
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
        resolve(flags).pipe(Effect.map((r) => ({ ...r, conn: withSuggestion(r.conn) }))),
      resolvePoolerFallback: (flags) =>
        resolvePoolerFallback(flags).pipe(Effect.map(Option.map(withSuggestion))),
    });
  }),
);

export const dbConfigLayer = dbConfigResolverLayer.pipe(Layer.provide(stackApiLayer));
