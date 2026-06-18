import * as net from "node:net";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import { getDomain } from "tldts";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_REF_PATTERN,
} from "../config/legacy-project-ref.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
} from "../../shared/legacy/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { LegacyDbConnection, type LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import { LegacyIdentityStitch } from "./legacy-identity-stitch.ts";
import {
  legacyLinkedDbResolverRuntimeLayer,
  type LegacyLinkedDbResolverRuntimeRequirements,
} from "./legacy-management-api-runtime.layer.ts";
import * as Errors from "./legacy-db-config.errors.ts";
import {
  parseLegacyConnectionString,
  redactLegacyConnectionString,
} from "./legacy-db-config.parse.ts";
import { LegacyDbConfigResolver, type LegacyDbConfigError } from "./legacy-db-config.service.ts";
import { legacyLoadProjectEnv, legacyReadDbToml } from "./legacy-db-config.toml-read.ts";
import type { LegacyDbConfigFlags } from "./legacy-db-config.types.ts";
import { LegacyDebugLogger } from "./legacy-debug-logger.service.ts";
import { legacyGetHostname } from "./legacy-hostname.ts";
import { mapLegacyHttpError } from "./legacy-http-errors.ts";

const DIRECT_PORT = 5432;
const TCP_PROBE_TIMEOUT = Duration.seconds(5);
const MAX_RETRIES = 8;
const BACKOFF_INITIAL = Duration.seconds(3);
const BACKOFF_MAX = Duration.seconds(60);
// Go: utils.SuggestEnvVar (`apps/cli-go/internal/utils/connect.go:174`).
const SUGGEST_ENV_VAR =
  "Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD";

const loginRoleErrorMapper = mapLegacyHttpError({
  networkError: Errors.LegacyDbConfigLoginRoleNetworkError,
  statusError: Errors.LegacyDbConfigLoginRoleStatusError,
  networkMessage: (cause) => `failed to initialise login role: ${cause}`,
  statusMessage: (status, body) => `unexpected login role status ${status}: ${body}`,
});

const listBansErrorMapper = mapLegacyHttpError({
  networkError: Errors.LegacyDbConfigListBansNetworkError,
  statusError: Errors.LegacyDbConfigListBansStatusError,
  networkMessage: (cause) => `failed to list network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected list bans status ${status}: ${body}`,
});

const unbanErrorMapper = mapLegacyHttpError({
  networkError: Errors.LegacyDbConfigUnbanNetworkError,
  statusError: Errors.LegacyDbConfigUnbanStatusError,
  networkMessage: (cause) => `failed to remove network bans: ${cause}`,
  statusMessage: (status, body) => `unexpected remove bans status ${status}: ${body}`,
});

/** `utils.IsLocalDatabase` (`connect.go:230`). Compares against the resolved local
 * services hostname (`utils.Config.Hostname`), not a hard-coded loopback. */
function isLocalDatabase(
  host: string,
  localHost: string,
  port: number,
  dbPort: number,
  shadowPort: number,
): boolean {
  return host === localHost && (port === dbPort || port === shadowPort);
}

/** Best-effort TCP reachability probe (Go dials direct host:5432 with a 5s timeout). */
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

export const legacyDbConfigLayer = Layer.effect(
  LegacyDbConfigResolver,
  Effect.gen(function* () {
    const cliConfig = yield* LegacyCliConfig;
    const dbConn = yield* LegacyDbConnection;
    const debug = yield* LegacyDebugLogger;
    const output = yield* Output;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Capture the ambient services the Management API stack needs, so the
    // lazily-built linked stack is fully self-provided and `resolve`'s R stays
    // `never` (handler tests can mock this resolver without wiring the whole
    // management runtime). None of these resolves an access token — only the
    // platform API layer does, and that is built only on the `--linked` branch.
    // `BunServices.layer` is included as a concrete layer (not a captured-value
    // `Layer.succeed`) because it provides FileSystem/Path, which have no single
    // tag to snapshot and which `legacyManagementApiRuntimeLayer` does not expose.
    const ambientLayer = Layer.mergeAll(
      Layer.succeed(LegacyProfileFlag, yield* LegacyProfileFlag),
      Layer.succeed(LegacyWorkdirFlag, yield* LegacyWorkdirFlag),
      Layer.succeed(LegacyOutputFlag, yield* LegacyOutputFlag),
      Layer.succeed(LegacyDebugFlag, yield* LegacyDebugFlag),
      // `legacyLinkedDbResolverRuntimeLayer`'s platform-API factory provides a DoH
      // fetch layer that reads `LegacyDnsResolverFlag`; snapshot it so the lazily
      // built linked stack stays fully self-provided (`resolve`'s R stays `never`).
      Layer.succeed(LegacyDnsResolverFlag, yield* LegacyDnsResolverFlag),
      Layer.succeed(RuntimeInfo, yield* RuntimeInfo),
      Layer.succeed(Analytics, yield* Analytics),
      Layer.succeed(TelemetryRuntime, yield* TelemetryRuntime),
      Layer.succeed(Tty, yield* Tty),
      Layer.succeed(Output, output),
      // The per-command identity stitcher, shared with the linked stack's lazy
      // platform-API factory + linked-project cache (Go's single root-context
      // `sync.Once`). Provided to this layer by each command runtime.
      Layer.succeed(LegacyIdentityStitch, yield* LegacyIdentityStitch),
      BunServices.layer,
    );
    // Compile-time guard: if `legacyLinkedDbResolverRuntimeLayer`'s requirements ever
    // grow a service not captured above, this assignment fails to type-check (the
    // lazy `Effect.provide` in the `--linked` branch would otherwise leak that
    // service into `resolve`'s R and only surface as a runtime panic). Mirrors the
    // `_serviceCoverageCheck` pattern in `legacy-management-api-runtime.layer.ts`.
    const _ambientCoverageCheck: Layer.Layer<
      LegacyLinkedDbResolverRuntimeRequirements,
      never,
      never
    > = ambientLayer;
    void _ambientCoverageCheck;

    // POST /v1/projects/{ref}/cli/login-role → mint a temporary postgres role.
    // The Management API client is built lazily via `LegacyPlatformApiFactory.make`
    // (not the eager `LegacyPlatformApi` stack), so the access token is resolved
    // only here — when a temp role is actually minted. `--linked --password` returns
    // before reaching this, so it stays auth-free (Go's `NewDbConfigWithPassword`);
    // `--local` / `--db-url` never build this layer at all.
    const initLoginRole = (ref: string, conn: LegacyPgConnInput) =>
      Effect.gen(function* () {
        const api = yield* (yield* LegacyPlatformApiFactory).make;
        // Go writes this to stderr unconditionally (not gated on --debug):
        // `apps/cli-go/internal/utils/flags/db_url.go` initLoginRole.
        yield* output.raw("Initialising login role...\n", "stderr");
        const role = yield* api.v1
          .createLoginRole({ ref, read_only: false })
          .pipe(Effect.catch(loginRoleErrorMapper));
        return { ...conn, user: role.role, password: role.password };
      });

    const listAndUnban = (ref: string) =>
      Effect.gen(function* () {
        const api = yield* (yield* LegacyPlatformApiFactory).make;
        const bans = yield* api.v1
          .listAllNetworkBans({ ref })
          .pipe(Effect.catch(listBansErrorMapper));
        const addrs = bans.banned_ipv4_addresses;
        if (addrs.length === 0) return;
        yield* api.v1
          .deleteNetworkBans({ ref, ipv4_addresses: [...addrs], requester_ip: false })
          .pipe(Effect.catch(unbanErrorMapper));
      });

    // Verify-connect with backoff while the pooler refreshes the temp password
    // (Go's `initPoolerLogin` → `backoff.RetryNotify`). On attempt ≥ 3, clear any
    // network ban on the requester (Go's notify callback).
    const waitForTempRole = (
      ref: string,
      conn: LegacyPgConnInput,
      dnsResolver: "native" | "https",
    ): Effect.Effect<void, LegacyDbConfigError, LegacyPlatformApiFactory> => {
      const attempt = (
        n: number,
      ): Effect.Effect<void, LegacyDbConfigError, LegacyPlatformApiFactory> =>
        // The temp-role probe always targets the remote Supavisor pooler, so it
        // connects with TLS (Go's pooler path goes through `ConnectByUrl`) and
        // honors `--dns-resolver` (Go's `ConnectByConfigStream` installs the DoH
        // resolver for this remote connect too).
        Effect.scoped(
          dbConn.connect(conn, { isLocal: false, dnsResolver }).pipe(Effect.asVoid),
        ).pipe(
          Effect.catch((cause) => {
            // Go's `backoff.WithMaxRetries(b, 8)` allows 8 retries after the
            // initial attempt → 9 total attempts. `n` is 1-based, so give up only
            // after attempt 9 (`n > MAX_RETRIES`), not at attempt 8.
            if (n > MAX_RETRIES) {
              return Effect.fail(
                new Errors.LegacyDbConfigConnectTempRoleError({
                  message: `failed to connect as temp role: ${cause.message}`,
                  suggestion: SUGGEST_ENV_VAR,
                }),
              );
            }
            // Mirrors Go's notify callback: from the 3rd failure onward, clear any
            // network ban on the requester. NOTE: Go's exponential backoff applies
            // ±50% jitter (RandomizationFactor=0.5); we use a deterministic curve
            // — intentional, jitter only matters under concurrent pooler refreshes.
            const unban = n >= 3 ? listAndUnban(ref) : Effect.void;
            const delayMs = Math.min(
              Duration.toMillis(BACKOFF_INITIAL) * 1.5 ** (n - 1),
              Duration.toMillis(BACKOFF_MAX),
            );
            return Effect.gen(function* () {
              // Go runs the unban inside `backoff.RetryNotify`'s notify callback,
              // which cannot abort the retry — `NewErrorCallback` only logs a callback
              // error and continues (`internal/utils/retry.go:28-29`). So a transient
              // ban-list/unban failure must NOT propagate out of the retry loop; log it
              // to --debug like Go, then discard.
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
      return attempt(1);
    };

    /**
     * Parse + validate the configured pooler connection string. Returns `None`
     * (treated as "no pooler", → IPv6 error) on any validation failure, matching
     * Go's `GetPoolerConfig`, which logs and returns `nil`.
     */
    const poolerConfigFrom = (
      ref: string,
      connectionString: string,
    ): Effect.Effect<Option.Option<LegacyPgConnInput>> =>
      Effect.gen(function* () {
        const sanitized = connectionString.replaceAll("[YOUR-PASSWORD]", "");
        const parsed = parseLegacyConnectionString(sanitized);
        if (parsed === undefined) {
          yield* debug.debug("failed to parse pooler URL");
          return Option.none();
        }
        // Preserve the libpq `options` startup param (Go keeps it in
        // `pgconn.Config.RuntimeParams`): legacy pooler URLs route by tenant via
        // `?options=reference=<ref>`, so the actual connection must carry it.
        const optionsParam = parsed.options ?? "";
        // Username must encode the project ref: either `<user>.<ref>` or the
        // `?options=reference=<ref>` query param.
        const dotIndex = parsed.user.indexOf(".");
        if (dotIndex === -1) {
          for (const option of optionsParam.split(",")) {
            const [key, value] = option.split("=");
            // Mirror Go's `strings.Cut` `found` guard (connect.go:83): only reject
            // when the `reference` option is present *with* a value that mismatches.
            // A bare `reference` token (no `=`) or a missing `reference` key is
            // accepted, exactly as Go does — do not reject on absence.
            if (key === "reference" && value !== undefined && value !== ref) {
              yield* debug.debug(`Pooler options does not match project ref: ${ref}`);
              return Option.none();
            }
          }
        } else if (parsed.user.slice(dotIndex + 1) !== ref) {
          yield* debug.debug(`Pooler username does not match project ref: ${ref}`);
          return Option.none();
        }
        // MITM guard: the pooler domain must belong to the active profile. The
        // expected host comes from the resolved profile (built-in table or a YAML
        // profile's `pooler_host:`), so custom/staging pooler domains are honored.
        const expectedPoolerHost = cliConfig.poolerHost;
        const domain = getDomain(parsed.host);
        if (domain === null) {
          yield* debug.debug("failed to parse pooler TLD");
          return Option.none();
        }
        if (
          expectedPoolerHost.length > 0 &&
          expectedPoolerHost.toLowerCase() !== domain.toLowerCase()
        ) {
          yield* debug.debug(`Pooler domain does not belong to current profile: ${domain}`);
          return Option.none();
        }
        // Supavisor transaction mode does not support prepared statements; use port 5432.
        return Option.some({
          ...parsed,
          port: DIRECT_PORT,
          ...(optionsParam.length > 0 ? { options: optionsParam } : {}),
        });
      });

    // Resolve the DB password with viper's precedence: `--password` flag →
    // `SUPABASE_DB_PASSWORD` shell env → project `.env*` value. `legacyLoadProjectEnv`
    // already excludes shell-set keys, so the shell value still wins over the file.
    const resolveDbPassword = (passwordFlag: Option.Option<string>) =>
      Effect.gen(function* () {
        const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
        return (
          Option.getOrUndefined(passwordFlag) ??
          process.env["SUPABASE_DB_PASSWORD"] ??
          projectEnv["SUPABASE_DB_PASSWORD"] ??
          ""
        );
      });

    // Resolve the IPv4 transaction pooler connection for `ref` (Go's
    // `GetPoolerConfig` + `initPoolerLogin`). Returns `None` when no pooler URL is
    // configured or it fails validation (Go's `GetPoolerConfig` returns nil), so the
    // caller can keep the original error. With a password, uses it directly; without
    // one, mints a temp login role and verify-connects through the pooler.
    const resolvePoolerConn = (
      ref: string,
      dnsResolver: "native" | "https",
      password: string,
      // Go's `ResolvePoolerConfigForFallback` (container-fallback only) falls back to
      // the Management API's primary pooler config when no `.temp/pooler-url` is saved;
      // the resolve-time IPv6 path (`NewDbConfigWithPassword` → `GetPoolerConfig`) uses
      // the saved URL only and errors otherwise, so this defaults off.
      fetchFromApi = false,
    ): Effect.Effect<
      Option.Option<LegacyPgConnInput>,
      LegacyDbConfigError,
      LegacyPlatformApiFactory
    > =>
      Effect.gen(function* () {
        const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
        let connectionString = Option.getOrUndefined(tomlValues.poolerConnectionString);
        if (connectionString === undefined) {
          if (!fetchFromApi) return Option.none();
          // No saved pooler URL → fetch the primary pooler config from the Management
          // API (Go's `GetPoolerConfigPrimary`, `connect.go:51-65`). Any API failure
          // means "no fallback" (Go returns ok=false), so swallow it to `None`.
          const api = yield* (yield* LegacyPlatformApiFactory).make;
          const configsOpt = yield* api.v1.getPoolerConfig({ ref }).pipe(Effect.option);
          if (Option.isNone(configsOpt)) return Option.none();
          const primary = configsOpt.value.find((config) => config.database_type === "PRIMARY");
          if (primary === undefined) return Option.none();
          connectionString = primary.connection_string;
        }
        const pooler = yield* poolerConfigFrom(ref, connectionString);
        if (Option.isNone(pooler)) return Option.none();
        const poolerConn = pooler.value;
        if (password.length > 0) {
          yield* debug.debug("Using database password from env var...");
          return Option.some({ ...poolerConn, password });
        }
        // Mint a temp role; preserve Supavisor's `<user>.<ref>` tenant suffix.
        const originalUser = poolerConn.user;
        const withRole = yield* initLoginRole(ref, poolerConn);
        const finalUser = originalUser.endsWith(`.${ref}`)
          ? `${withRole.user}.${ref}`
          : withRole.user;
        const tempConn = { ...withRole, user: finalUser };
        yield* waitForTempRole(ref, tempConn, dnsResolver);
        return Option.some(tempConn);
      });

    const resolveLinked = (
      ref: string,
      dnsResolver: "native" | "https",
      passwordFlag: Option.Option<string>,
    ): Effect.Effect<LegacyPgConnInput, LegacyDbConfigError, LegacyPlatformApiFactory> =>
      Effect.gen(function* () {
        // Read lazily (per invocation) rather than at layer build, so tests and
        // env-substitution see the current value.
        const dbPassword = yield* resolveDbPassword(passwordFlag);
        const host = `db.${ref}.${cliConfig.projectHost}`;
        const base: LegacyPgConnInput = {
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

        // Direct host unreachable (IPv6-only network) → try the pooler.
        const poolerConn = yield* resolvePoolerConn(ref, dnsResolver, base.password);
        if (Option.isNone(poolerConn)) {
          return yield* Effect.fail(
            new Errors.LegacyDbConfigIpv6Error({
              message: "IPv6 is not supported on your current network",
              suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
            }),
          );
        }
        return poolerConn.value;
      });

    const resolve = (flags: LegacyDbConfigFlags) =>
      Effect.gen(function* () {
        const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
        // Go's `utils.Config.Hostname` (`GetHostname()`): honors
        // `SUPABASE_SERVICES_HOSTNAME` / a tcp `DOCKER_HOST` in dev-container or
        // remote-Docker setups, defaulting to 127.0.0.1.
        const localHost = legacyGetHostname();

        // --db-url (direct) takes precedence.
        if (flags.connType === "db-url" && Option.isSome(flags.dbUrl)) {
          // Go's direct path runs `LoadConfig` before `pgconn.ParseConfig`
          // (`internal/utils/flags/db_url.go:59-68`), so the project `.env*` files
          // populate the environment that the libpq `PG*` fallbacks read. Layer the
          // project env under the shell env (`legacyLoadProjectEnv` already excludes
          // shell-set keys, so the shell still wins) and feed it to the parser.
          const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
          const parseEnv = (name: string): string | undefined =>
            process.env[name] ?? projectEnv[name];
          const conn = parseLegacyConnectionString(flags.dbUrl.value, parseEnv);
          if (conn === undefined) {
            return yield* Effect.fail(
              new Errors.LegacyDbConfigParseUrlError({
                // Redact the password component before echoing the URL back
                // (CWE-209): a malformed `--db-url` often still carries a secret.
                message: `failed to parse connection string: ${redactLegacyConnectionString(flags.dbUrl.value)}`,
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
          // Go routes a local direct URL through `ConnectLocalPostgres`
          // (`connect.go:137`), which fills an empty password from the local
          // `[db].password` config so a passwordless local DSL like
          // `postgresql://postgres@127.0.0.1:54322/postgres` still authenticates.
          return {
            conn:
              isLocal && conn.password.length === 0
                ? { ...conn, password: tomlValues.password }
                : conn,
            isLocal,
          };
        }

        // --linked. The lazy Management API runtime (project-ref resolver + lazy
        // platform API factory) is provided here at runtime so it is only built on
        // this branch — `--local` and `--db-url` never touch it. The factory resolves
        // the access token only on first use (minting a temp role), so a
        // `--linked --password` invocation stays auth-free, matching Go.
        if (flags.connType === "linked") {
          const linked = yield* Effect.gen(function* () {
            const projectRef = yield* LegacyProjectRefResolver;
            // Go's ParseDatabaseConfig resolves the linked ref via the HARD `LoadProjectRef`
            // (`apps/cli-go/internal/utils/flags/db_url.go:88`) — load-or-fail with no
            // prompt, format validation, and `failed to load project ref` on a real
            // `.temp/project-ref` read error. Use `loadProjectRef` (not the soft
            // `resolveOptional`, which swallows that read error to None): an unlinked
            // workdir fails with ErrNotLinked, a bad ref with the invalid-ref error, and an
            // unreadable ref file surfaces the filesystem problem — matching Go for every
            // caller of this resolver (`test db --linked`, dump, declarative).
            const ref = yield* projectRef.loadProjectRef(Option.none());
            // Go's `ParseDatabaseConfig` runs `LoadProjectRef` → `LoadConfig` →
            // `NewDbConfigWithPassword` (`internal/utils/flags/db_url.go:81-92`), so
            // the `[remotes.<ref>]`-merged config (e.g. an unsupported remote
            // `db.major_version` / `edge_runtime.deno_version`) is validated as a pure
            // config error BEFORE any network work. The base read in `resolve` above
            // only validates remote `project_id`s, not the ref-merged block — so
            // validate the merged config here, before `resolveLinked`'s TCP probe /
            // pooler / temp-role Management API calls, rather than letting those mask
            // (or run side effects ahead of) the real config error.
            yield* legacyReadDbToml(fs, path, cliConfig.workdir, ref);
            const resolved = yield* resolveLinked(
              ref,
              flags.dnsResolver,
              flags.password ?? Option.none(),
            );
            // NB: the linked-project telemetry cache (GET /v1/projects/{ref}) is NOT
            // issued here. Go caches it in `PersistentPostRun`
            // (`ensureProjectGroupsCached`, cmd/root.go:214-234) — i.e. AFTER the
            // command's own API calls — so each linked command owns that GET in its
            // post-run finalizer (see e.g. advisors/query handlers). Issuing it mid-
            // resolve reordered the request log ahead of the command's GETs.
            return { conn: resolved, ref };
          }).pipe(
            Effect.provide(
              legacyLinkedDbResolverRuntimeLayer(["test", "db"]).pipe(Layer.provide(ambientLayer)),
            ),
          );
          // Surface the resolved ref so the caller can re-read config with a matching
          // `[remotes.<ref>]` override applied (Go merges it into the linked config).
          return { conn: linked.conn, isLocal: false, ref: Option.some(linked.ref) };
        }

        // --local (default).
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

    // Go's `RunWithPoolerFallback` (`internal/db/dump/pooler_fallback.go`): when a
    // linked dump's pg_dump container fails with an IPv6 connectivity error (the
    // direct host is reachable from the CLI process but not from inside Docker), it
    // resolves the project's IPv4 transaction pooler and retries once. This exposes
    // that pooler resolution (Go's `ResolvePoolerConfigForFallback`) for the dump
    // handler to invoke on demand. Returns `None` when the path is not pooler-eligible
    // (`--linked` only) or no pooler URL is configured, so the caller keeps the
    // original container error.
    const resolvePoolerFallback = (flags: LegacyDbConfigFlags) =>
      Effect.gen(function* () {
        if (flags.connType !== "linked") return Option.none<LegacyPgConnInput>();
        return yield* Effect.gen(function* () {
          const projectRef = yield* LegacyProjectRefResolver;
          const refOpt = yield* projectRef.resolveOptional(Option.none());
          if (Option.isNone(refOpt)) return Option.none<LegacyPgConnInput>();
          const ref = refOpt.value;
          if (!PROJECT_REF_PATTERN.test(ref)) return Option.none<LegacyPgConnInput>();
          const password = yield* resolveDbPassword(flags.password ?? Option.none());
          // Container-fallback: fetch the primary pooler config from the Management API
          // when no `.temp/pooler-url` is saved (Go's `ResolvePoolerConfigForFallback`).
          return yield* resolvePoolerConn(ref, flags.dnsResolver, password, true);
        }).pipe(
          Effect.provide(
            legacyLinkedDbResolverRuntimeLayer(["db", "dump"]).pipe(Layer.provide(ambientLayer)),
          ),
        );
      });

    return LegacyDbConfigResolver.of({ resolve, resolvePoolerFallback });
  }),
);
