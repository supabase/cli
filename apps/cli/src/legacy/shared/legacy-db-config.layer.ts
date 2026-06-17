import * as net from "node:net";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import { getDomain } from "tldts";

import { legacyCredentialsLayer } from "../auth/legacy-credentials.layer.ts";
import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { legacyPlatformApiFactoryLayer } from "../auth/legacy-platform-api-factory.layer.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { LegacyProjectRefResolver } from "../config/legacy-project-ref.service.ts";
import { legacyProjectRefLayer } from "../config/legacy-project-ref.layer.ts";
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
import { LegacyIdentityStitch } from "./legacy-identity-stitch.ts";
import { LegacyDbConnection, type LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import type { LegacyManagementApiRuntimeError } from "./legacy-management-api-runtime.layer.ts";
import { legacyDebugLoggerLayer } from "./legacy-debug-logger.layer.ts";
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

/**
 * Lazy Management API stack for the `--linked` branch. Unlike the eager
 * `legacyManagementApiRuntimeLayer` (which builds `LegacyPlatformApi` and
 * resolves an access token at layer-construction time), this provides the lazy
 * `LegacyPlatformApiFactory` + the project-ref resolver, so the token is
 * resolved only when `resolveLinked` actually forces `factory.make` to mint a
 * temp role / clear network bans. A password-only linked connection (reachable
 * host + `SUPABASE_DB_PASSWORD`) returns early without ever forcing the factory,
 * matching Go's `NewDbConfigWithPassword` (`internal/utils/flags/db_url.go`),
 * which only needs the token on the no-password temp-role path. The stack's
 * ambient requirements (config flags, Analytics, TelemetryRuntime, Tty, Output,
 * FileSystem/Path) are satisfied by `ambientLayer` at provide time.
 */
const linkedCliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const linkedCredentials = legacyCredentialsLayer.pipe(
  Layer.provide(linkedCliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);
const linkedPlatformApiFactory = legacyPlatformApiFactoryLayer.pipe(
  Layer.provide(linkedCredentials),
  Layer.provide(linkedCliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);
const linkedProjectRef = legacyProjectRefLayer.pipe(
  Layer.provide(linkedPlatformApiFactory),
  Layer.provide(linkedCliConfig),
);
const lazyLinkedManagementStack = Layer.mergeAll(linkedPlatformApiFactory, linkedProjectRef);

type LegacyLinkedManagementRequirements =
  typeof lazyLinkedManagementStack extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

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
      // `legacyPlatformApiFactoryLayer` now provides `legacyDohFetchLayer`, which
      // reads `LegacyDnsResolverFlag`. Snapshot it here so the lazily-built linked
      // stack stays fully self-provided (`resolve`'s R remains `never`).
      Layer.succeed(LegacyDnsResolverFlag, yield* LegacyDnsResolverFlag),
      Layer.succeed(RuntimeInfo, yield* RuntimeInfo),
      Layer.succeed(Analytics, yield* Analytics),
      Layer.succeed(TelemetryRuntime, yield* TelemetryRuntime),
      Layer.succeed(Tty, yield* Tty),
      Layer.succeed(Output, output),
      // Snapshot the one per-command identity stitcher so the lazily-built linked
      // platform-API factory shares the SAME `stitchAttempted` guard as the typed
      // client / advisor GETs / cache (Go's single root-context `sync.Once`).
      // Provided to `legacyDbConfigLayer` by each command runtime (lint/advisors).
      Layer.succeed(LegacyIdentityStitch, yield* LegacyIdentityStitch),
      BunServices.layer,
    );
    // Compile-time guard: if `lazyLinkedManagementStack`'s requirements ever grow
    // a service not captured above, this assignment fails to type-check (the lazy
    // `Effect.provide` in the `--linked` branch would otherwise leak that service
    // into `resolve`'s R and only surface as a runtime panic). Mirrors the
    // `_serviceCoverageCheck` pattern in `legacy-management-api-runtime.layer.ts`.
    const _ambientCoverageCheck: Layer.Layer<LegacyLinkedManagementRequirements, never, never> =
      ambientLayer;
    void _ambientCoverageCheck;

    // POST /v1/projects/{ref}/cli/login-role → mint a temporary postgres role.
    // The access token is resolved here — by forcing the lazy
    // `LegacyPlatformApiFactory.make` — NOT at layer build, so the password-only
    // linked path (which returns before reaching this) and `--local`/`--db-url`
    // stay auth-free. Go prints "Initialising login role..." before constructing
    // the client, so the stderr line precedes any token-resolution failure.
    const initLoginRole = (ref: string, conn: LegacyPgConnInput) =>
      Effect.gen(function* () {
        const factory = yield* LegacyPlatformApiFactory;
        // Go writes this to stderr unconditionally (not gated on --debug):
        // `apps/cli-go/internal/utils/flags/db_url.go` initLoginRole.
        yield* output.raw("Initialising login role...\n", "stderr");
        // Let token-resolution failures propagate raw (Go's `GetSupabase()` →
        // `LoadAccessTokenFS` exits with the raw missing/invalid-token message,
        // `internal/utils/api.go:121-123`). Only the createLoginRole HTTP call is
        // wrapped as "failed to initialise login role" (`db_url.go:206-208`).
        const api = yield* factory.make;
        const role = yield* api.v1
          .createLoginRole({ ref, read_only: false })
          .pipe(Effect.catch(loginRoleErrorMapper));
        return { ...conn, user: role.role, password: role.password };
      });

    const listAndUnban = (ref: string) =>
      Effect.gen(function* () {
        const factory = yield* LegacyPlatformApiFactory;
        const api = yield* factory.make;
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
    ): Effect.Effect<
      void,
      LegacyDbConfigError | LegacyManagementApiRuntimeError,
      LegacyPlatformApiFactory
    > => {
      const attempt = (
        n: number,
      ): Effect.Effect<
        void,
        LegacyDbConfigError | LegacyManagementApiRuntimeError,
        LegacyPlatformApiFactory
      > =>
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
              // Go runs the unban inside the backoff *notify* callback
              // (`utils.NewErrorCallback`), whose error is printed and swallowed —
              // a `backoff.Notify` returns nothing, so it can never abort the
              // retry loop (`apps/cli-go/internal/utils/retry.go:27-29`). Mirror
              // that: on an unban failure, print to stderr (Go's logger is
              // os.Stderr from the 3rd failure on, and unban only runs at n >= 3)
              // and keep retrying — never let the Management API error escape.
              yield* unban.pipe(
                Effect.catch((banError) => output.raw(`${banError.message}\n`, "stderr")),
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

    const resolveLinked = (
      ref: string,
      dnsResolver: "native" | "https",
    ): Effect.Effect<
      LegacyPgConnInput,
      LegacyDbConfigError | LegacyManagementApiRuntimeError,
      LegacyPlatformApiFactory
    > =>
      Effect.gen(function* () {
        // Read lazily (per invocation) rather than at layer build, so tests and
        // env-substitution see the current value. Go reads viper `DB_PASSWORD`
        // after `loadNestedEnv` has populated the environment from the project
        // `.env*` files, so honor those too — `legacyLoadProjectEnv`'s map already
        // excludes keys present in the shell env, so the shell value still wins.
        const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
        const dbPassword =
          process.env["SUPABASE_DB_PASSWORD"] ?? projectEnv["SUPABASE_DB_PASSWORD"] ?? "";
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
        const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
        const poolerString = tomlValues.poolerConnectionString;
        if (Option.isNone(poolerString)) {
          return yield* Effect.fail(
            new Errors.LegacyDbConfigIpv6Error({
              message: "IPv6 is not supported on your current network",
              suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
            }),
          );
        }
        const pooler = yield* poolerConfigFrom(ref, poolerString.value);
        if (Option.isNone(pooler)) {
          return yield* Effect.fail(
            new Errors.LegacyDbConfigIpv6Error({
              message: "IPv6 is not supported on your current network",
              suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
            }),
          );
        }
        const poolerConn = pooler.value;
        if (base.password.length > 0) {
          yield* debug.debug("Using database password from env var...");
          return { ...poolerConn, password: base.password };
        }
        // Mint a temp role; preserve Supavisor's `<user>.<ref>` tenant suffix.
        const originalUser = poolerConn.user;
        const withRole = yield* initLoginRole(ref, poolerConn);
        const finalUser = originalUser.endsWith(`.${ref}`)
          ? `${withRole.user}.${ref}`
          : withRole.user;
        const tempConn = { ...withRole, user: finalUser };
        yield* waitForTempRole(ref, tempConn, dnsResolver);
        return tempConn;
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

        // --linked. The lazy Management API stack (project-ref resolver + the
        // lazy platform-API factory) is provided here at runtime so it is only
        // built on this branch — `--local` and `--db-url` never touch it. The
        // access token is resolved only when `resolveLinked` forces the factory
        // (temp-role mint / unban), so a password-only linked connection works
        // without a token, matching Go's `NewDbConfigWithPassword`.
        if (flags.connType === "linked") {
          const conn = yield* Effect.gen(function* () {
            const projectRef = yield* LegacyProjectRefResolver;
            // Go's `ParseDatabaseConfig` linked branch uses `flags.LoadProjectRef`
            // (`internal/utils/flags/db_url.go:88`) — non-prompting, hard-failing
            // with ErrNotLinked. Match it so the whole db family (`lint`, `dump`,
            // `push`, `pull`, `reset`, `query`) fails fast on `--linked` without a
            // linked-project file instead of opening an interactive picker.
            const ref = yield* projectRef.loadProjectRef(Option.none());
            return yield* resolveLinked(ref, flags.dnsResolver);
          }).pipe(Effect.provide(lazyLinkedManagementStack.pipe(Layer.provide(ambientLayer))));
          return { conn, isLocal: false };
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

    return LegacyDbConfigResolver.of({ resolve });
  }),
);
