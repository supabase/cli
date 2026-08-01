import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  LegacyDebugFlag,
  LegacyNetworkIdFlag,
  legacyResolveExperimentalWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyIsBitbucketPipeline } from "../../../shared/legacy-bitbucket-pipeline.ts";
import { legacyCheckDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import {
  legacyCliProjectFilterValue,
  legacyResolveNetworkId,
  localDbContainerId,
} from "../../../shared/legacy-docker-ids.ts";
import {
  legacyEnvOverrideApiMaxRows,
  legacyEnvOverrideBool,
  legacyEnvOverrideDefaultPoolSize,
  legacyEnvOverrideEdgeRuntimePolicy,
  legacyEnvOverrideMaxClientConn,
  legacyEnvOverridePoolMode,
  legacyEnvOverridePort,
  legacyEnvOverrideRealtimeIpVersion,
  legacyEnvOverrideRealtimeMaxHeaderLength,
  legacyEnvOverrideUint,
  legacyResolveAuthEmail,
  legacyResolveAuthExternalProviders,
  legacyResolveAuthExternalUrl,
  legacyResolveAuthMfa,
  legacyResolveAuthSms,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveGotrueOAuthServer,
  legacyResolveGotruePasskeyWebauthn,
  legacyResolveGotrueRateLimit,
  legacyResolveGotrueSessions,
  legacyResolveGotrueWeb3,
  legacyResolveLocalConfigValues,
  legacyResolveLocalJwks,
} from "../../../shared/legacy-local-config-values.ts";
import { legacyParseGoDuration } from "../../../shared/legacy-go-duration.ts";
import { legacyLoadLocalProjectContext } from "../../../shared/legacy-local-project-context.ts";
import { legacyResolveDbBootstrapConfig } from "../../../shared/db-bootstrap/bootstrap-config.ts";
import { legacyEnsureImagesCached } from "../../../shared/db-bootstrap/image-prepull.ts";
import { legacyIsLocalDbRunning } from "../../../shared/db-bootstrap/local-db-running.ts";
import { legacyRollbackStart } from "../../../shared/db-bootstrap/rollback.ts";
import { legacyStartDatabase } from "../../../shared/db-bootstrap/start-database.ts";
import type { LegacyStartContainerOpts } from "../../../shared/db-bootstrap/container-lifecycle.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps a synchronous resolver/parser that throws on a malformed config value into a typed
 * `LegacyDbConfigLoadError` failure — mirrors `commands/start/start.handler.ts`'s identical
 * `wrapConfigOverride`, matching Go's `Config.Load` hard-failing on a bad Viper decode
 * (`pkg/config/config.go:749-756`) before any Docker work runs.
 */
function wrapDbConfigOverride<T>(
  dottedFieldPath: string,
  thunk: () => T,
): Effect.Effect<T, LegacyDbConfigLoadError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      new LegacyDbConfigLoadError({
        message: `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

/**
 * `supabase db start` — start the local Postgres database.
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/start/start.go` `Run` + `StartDatabase`.
 * `Run` is native TS here: config load+validate, the already-running short-circuit, and
 * this command's own lean prelude. The `StartDatabase` sequence itself
 * (network/volume/container bring-up, health wait, fresh-volume setup, `_current_branch`)
 * is the SAME shared function `supabase start` uses — see
 * `legacy/shared/db-bootstrap/start-database.ts`'s header for why this is a single,
 * shared TS home rather than two independently-drifting copies. The already-running
 * check (`legacyIsLocalDbRunning`) is already a native TS implementation of
 * `AssertSupabaseDbIsRunning` (a plain `docker container inspect`), not a Go subprocess
 * or a seam call — `db start` composes no `LegacyDbBootstrapSeam` at all anymore; the
 * container-bootstrap Go delegation (`db __db-bootstrap --mode start`) has been
 * removed entirely.
 *
 * Parity notes: this is `db start`, NOT the top-level `supabase start`. It does NOT print
 * a status table and does NOT fire `cli_stack_started` — those belong to
 * `internal/start/start.go`. There is no `Finished` line. Unlike `supabase start`, there
 * is no `--exclude`/`--ignore-health-check` here at all (Go's `db start` has neither
 * flag) — a health-check timeout always fails the command UNLESS `--from-backup` is set,
 * in which case `legacyStartDatabase` itself swallows it (a large restore can take longer
 * than the health timeout, `start.go:179-181`) and the command still succeeds.
 * `--exclude`'s absence also means the fresh-volume one-shot setup jobs (realtime/storage/
 * auth migrate) are gated purely on each service's own `enabled` flag, with no `--exclude`
 * filtering to layer on top.
 */
export const legacyDbStart = Effect.fn("legacy.db.start")(function* (flags: LegacyDbStartFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const networkIdFlag = yield* LegacyNetworkIdFlag;
  const debug = yield* LegacyDebugFlag;

  const body = Effect.gen(function* () {
    // Go's `flags.LoadConfig(fsys)` runs first thing in `start.Run`
    // (`internal/db/start/start.go:45`): a missing config is tolerated (defaults), but
    // a present config that is malformed, references an undecryptable `encrypted:`
    // secret, or fails Validate aborts before any container work. `legacyCheckDbToml`
    // is that exact load+validate — call it here (not via `legacyIsLocalDbRunning`'s
    // best-effort read, which swallows config errors) so `db start` fails fast on a
    // broken config.
    yield* legacyCheckDbToml(fs, path, cliConfig.workdir);

    // The rest of Go's `flags.LoadConfig` — full config decode/resolution
    // (`legacyLoadLocalProjectContext`) plus the eager `time.Duration` field validation right
    // below — ALSO runs before `AssertSupabaseDbIsRunning` in Go's `start.Run`
    // (`internal/db/start/start.go:45-47`), so a malformed `auth.*` duration field must fail
    // `db start` even when Postgres is already running, not just on a fresh start. Load it here,
    // ahead of the already-running short-circuit below, instead of deferring it to the
    // not-running branch (previously this ran after the short-circuit, so an "already running"
    // db would mask the config error).
    const context = yield* legacyLoadLocalProjectContext(
      cliConfig.workdir,
      (message) => new LegacyDbConfigLoadError({ message }),
    );
    const { config, projectEnvValues, loaded, hostname, projectId } = context;

    // Go decodes every `time.Duration` config field — including these 5 — in the same single,
    // unconditional `Config.Load` pass (`mapstructure.StringToTimeDurationHookFunc()`,
    // `pkg/config/config.go:749-756,777`), before `db start` touches Docker (or even checks
    // whether Postgres is already running) at all (`internal/db/start/start.go:45-47`) —
    // regardless of whether `db start` itself ever reads the field. `db start` never starts
    // GoTrue (only `supabase start` does, whose OWN identical eager-validation block this
    // mirrors — see `commands/start/start.handler.ts`'s `wrapConfigOverride` call sites), so
    // nothing else in this handler ever parses `auth.email`/`auth.sms`/`auth.sessions`/
    // `auth.mfa`'s duration fields — without this, a malformed value would be silently accepted
    // here instead of failing the command, unlike Go. Discarding the parsed values: only the
    // fail-fast behavior matters for this command.
    const authDocForValidation = asRecord(loaded?.document?.["auth"]);
    const resolvedEmailForValidation = yield* wrapDbConfigOverride("auth.email", () =>
      legacyResolveAuthEmail(config.auth.email, authDocForValidation, projectEnvValues),
    );
    yield* wrapDbConfigOverride("auth.email.max_frequency", () =>
      legacyParseGoDuration(resolvedEmailForValidation.max_frequency),
    );
    const smsForValidation = yield* wrapDbConfigOverride("auth.sms", () =>
      legacyResolveAuthSms(authDocForValidation, config.auth.sms, projectEnvValues),
    );
    yield* wrapDbConfigOverride("auth.sms.max_frequency", () =>
      legacyParseGoDuration(smsForValidation.max_frequency),
    );
    // Go's `(s *sms) validate()` — including this print and the `EnableSignup` downgrade — only
    // runs `if c.Auth.Enabled` (`config.go:1087,1145`); `legacyResolveAuthSms` already applies the
    // downgrade unconditionally (needed for the duration check above, which Go decodes regardless
    // of `auth.enabled`), so the warning itself must be re-gated here on the SAME
    // `SUPABASE_AUTH_ENABLED`-overridden value `Validate` reads, or a disabled-auth project with
    // `sms.enable_signup = true` and no provider would wrongly print a warning Go never emits.
    const authEnabledForValidation = legacyEnvOverrideBool(
      "SUPABASE_AUTH_ENABLED",
      config.auth.enabled,
      "auth.enabled",
      projectEnvValues,
    );
    if (
      authEnabledForValidation &&
      !smsForValidation.twilio.enabled &&
      !smsForValidation.twilio_verify.enabled &&
      !smsForValidation.messagebird.enabled &&
      !smsForValidation.textlocal.enabled &&
      !smsForValidation.vonage.enabled &&
      legacyEnvOverrideBool(
        "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
        config.auth.sms.enable_signup,
        "auth.sms.enable_signup",
        projectEnvValues,
      )
    ) {
      yield* output.raw("WARN: no SMS provider is enabled. Disabling phone login\n", "stderr");
    }
    const gotrueSessionsForValidation = legacyResolveGotrueSessions(
      config.auth.sessions,
      projectEnvValues,
    );
    if (gotrueSessionsForValidation?.timebox !== undefined) {
      yield* wrapDbConfigOverride("auth.sessions.timebox", () =>
        legacyParseGoDuration(gotrueSessionsForValidation.timebox!),
      );
    }
    if (gotrueSessionsForValidation?.inactivity_timeout !== undefined) {
      yield* wrapDbConfigOverride("auth.sessions.inactivity_timeout", () =>
        legacyParseGoDuration(gotrueSessionsForValidation.inactivity_timeout!),
      );
    }
    yield* wrapDbConfigOverride("auth.mfa.phone.max_frequency", () =>
      legacyParseGoDuration(
        legacyResolveAuthMfa(config.auth.mfa, projectEnvValues).phone.max_frequency,
      ),
    );
    // Go's `Auth.RateLimit` (plain `uint`s, `pkg/config/auth.go:200-208`) is decoded by the SAME
    // unconditional `Config.Load` pass as the duration fields above — unlike `auth.sms`/`auth.mfa`,
    // it has no `Enabled`-gated `validate()` method at all (`config.go:1087-1153` never mentions
    // it), so a malformed override (e.g. `SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=bogus`) must fail
    // `db start` regardless of `auth.enabled`, matching `commands/start/start.handler.ts`'s
    // identical eager call.
    yield* wrapDbConfigOverride("auth.rate_limit", () =>
      legacyResolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
    );
    // Same gap for `auth.jwt_expiry` — a plain `uint` (`pkg/config/auth.go:155`) decoded by the
    // SAME unconditional `Config.Load` pass as `auth.rate_limit` above, with no `Enabled`-gated
    // `validate()` method of its own. Below, it's only ever resolved as part of
    // `values.authJwtExpiry` (`legacyResolveLocalConfigValues`), which this handler calls ONLY in
    // the not-running branch — so a malformed `SUPABASE_AUTH_JWT_EXPIRY` would otherwise be
    // silently accepted whenever Postgres is already running, unlike Go, which decodes it before
    // `AssertSupabaseDbIsRunning` regardless (review: PRRT_kwDOErm0O86VmpeG).
    yield* wrapDbConfigOverride("auth.jwt_expiry", () =>
      legacyEnvOverrideUint(
        "SUPABASE_AUTH_JWT_EXPIRY",
        "auth.jwt_expiry",
        config.auth.jwt_expiry,
        projectEnvValues,
      ),
    );

    // The rest of the eager-validation battery: Go's `Config.Load` decodes the ENTIRE config
    // struct in one `v.UnmarshalExact` pass (`pkg/config/config.go`'s `(c *config) load`),
    // regardless of which command invoked it or whether that command's own downstream logic ever
    // reads the field — `db start` and `supabase start` both funnel through this same
    // `flags.LoadConfig` entrypoint. `commands/start/start.handler.ts` already validates every
    // field below (its own `wrapConfigOverride` battery); this mirrors those exact calls here so
    // `db start` fails just as fast on a malformed non-auth field, regardless of whether `db
    // start` itself ever reads it (review: PRRT_kwDOErm0O86VlOHQ).

    // Same gap for the remaining GoTrue overrides: `auth.web3.*.enabled`/`auth.oauth_server.
    // {enabled,allow_dynamic_registration}` (plain `bool`s, `pkg/config/auth.go:371-382,394-398`)
    // and `auth.passkey.enabled`/`auth.webauthn.*`/per-provider `auth.external.<name>.
    // {enabled,skip_nonce_check,email_optional}` (unmodeled raw booleans, `auth.go:166-176,
    // 190,361-391`) are all decoded in the same unconditional `Config.Load` pass as `auth.
    // rate_limit` above, regardless of whether `db start` itself ever reads them — `db start`
    // never builds a GoTrue container at all (this module's own header), so nothing else in this
    // handler ever calls any of these four resolvers. Each already throws internally on a bad
    // override, so calling each here, once, eagerly, and discarding the result closes the gap.
    // `auth.oauth_server.authorization_url_path` is a plain string and can't throw, so it needs no
    // eager check.
    //
    // NOT a reimplementation of `Config.Validate`'s passkey/webauthn RULE (review:
    // PRRT_kwDOErm0O86VlqIK): the "Missing required config section: auth.webauthn.../rp_id/
    // rp_origins" checks (`config.go:1117-1134`) are decode-INDEPENDENT semantic validation that
    // already, exclusively lives in `legacyValidateResolvedConfig` — this handler's very first
    // line runs `legacyCheckDbToml`, which builds `LegacyPasskeyInput` and calls that single
    // shared validator before ANY of this eager-decode battery executes, so a malformed/
    // incomplete `[auth.passkey]`/`[auth.webauthn]` section already fails fast there. The call
    // below is the SAME `legacy-local-config-values.ts` resolver `start`'s own identical battery
    // (and `db start`'s later GoTrue-container-building path, were it to build one) already call —
    // invoked here only to force its internal `legacyEnvOverrideBool`/`legacyRawUnmodeledBool`
    // decode-hook errors (a malformed `SUPABASE_AUTH_PASSKEY_ENABLED`, etc.) to surface eagerly,
    // matching Go's unconditional `Config.Load` field decode. No validation logic is duplicated
    // here — only the pre-existing, already-shared resolver is called again, and its result is
    // discarded.
    yield* wrapDbConfigOverride("auth.web3", () =>
      legacyResolveGotrueWeb3(config.auth.web3, projectEnvValues),
    );
    yield* wrapDbConfigOverride("auth.oauth_server", () =>
      legacyResolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
    );
    yield* wrapDbConfigOverride("auth.passkey", () =>
      legacyResolveGotruePasskeyWebauthn(loaded?.document, projectEnvValues),
    );
    yield* wrapDbConfigOverride("auth.external", () =>
      legacyResolveAuthExternalProviders(
        authDocForValidation,
        config.auth.external,
        projectEnvValues,
      ),
    );

    // Same gap for `api.enabled`/`api.tls.enabled` — plain bools decoded in the same
    // unconditional `Config.Load` pass (`pkg/config/config.go:1006-1027`), regardless of whether
    // `db start` itself ever reads them: it never builds Kong or any other HTTP-facing container
    // (this module's own header), so neither value is consumed here. Discarded.
    yield* wrapDbConfigOverride("api.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_API_ENABLED",
        config.api.enabled,
        "api.enabled",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("api.tls.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_API_TLS_ENABLED",
        config.api.tls.enabled,
        "api.tls.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `api.max_rows` — a plain uint only PostgREST/Studio ever read; `db start`
    // builds neither container, so the resolved value is discarded here too.
    yield* wrapDbConfigOverride("api.max_rows", () =>
      legacyEnvOverrideApiMaxRows(config.api.max_rows, projectEnvValues),
    );

    // Same gap for `storage.vector.enabled`/`storage.s3_protocol.enabled`/`storage.analytics.
    // enabled` and their five plain-uint siblings (`storage.analytics.{max_namespaces,max_tables,
    // max_catalogs}`/`storage.vector.{max_buckets,max_indexes}`) — all decoded unconditionally in
    // the same `Config.Load` pass (`pkg/config/storage.go:16-45`), regardless of whether `db
    // start` itself ever reads them: it never builds the Storage container. Discarded.
    yield* wrapDbConfigOverride("storage.vector.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_VECTOR_ENABLED",
        config.storage.vector.enabled,
        "storage.vector.enabled",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.s3_protocol.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        config.storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.analytics.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_ANALYTICS_ENABLED",
        config.storage.analytics.enabled,
        "storage.analytics.enabled",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.analytics.max_namespaces", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
        "storage.analytics.max_namespaces",
        config.storage.analytics.max_namespaces,
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.analytics.max_tables", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
        "storage.analytics.max_tables",
        config.storage.analytics.max_tables,
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.analytics.max_catalogs", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
        "storage.analytics.max_catalogs",
        config.storage.analytics.max_catalogs,
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.vector.max_buckets", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
        "storage.vector.max_buckets",
        config.storage.vector.max_buckets,
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("storage.vector.max_indexes", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
        "storage.vector.max_indexes",
        config.storage.vector.max_indexes,
        projectEnvValues,
      ),
    );

    // Same gap for Mailpit's three ports and Logflare's two — Go's `Config.Load` applies
    // `SUPABASE_LOCAL_SMTP_{PORT,SMTP_PORT,POP3_PORT}`/`SUPABASE_ANALYTICS_{PORT,VECTOR_PORT}`
    // generically (`pkg/config/config.go:580-586`), regardless of whether `db start` itself ever
    // reads them: it never builds Mailpit or Logflare. `smtp_port`/`pop3_port`/`vector_port` have
    // no TOML default (Go's zero-value `uint16`), matching `commands/start/start.handler.ts`'s own
    // `?? 0` fallback. Discarded.
    yield* wrapDbConfigOverride("local_smtp.port", () =>
      legacyEnvOverridePort(
        "SUPABASE_LOCAL_SMTP_PORT",
        config.local_smtp.port,
        "local_smtp.port",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("local_smtp.smtp_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_LOCAL_SMTP_SMTP_PORT",
        config.local_smtp.smtp_port ?? 0,
        "local_smtp.smtp_port",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("local_smtp.pop3_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_LOCAL_SMTP_POP3_PORT",
        config.local_smtp.pop3_port ?? 0,
        "local_smtp.pop3_port",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("analytics.port", () =>
      legacyEnvOverridePort(
        "SUPABASE_ANALYTICS_PORT",
        config.analytics.port,
        "analytics.port",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("analytics.vector_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_ANALYTICS_VECTOR_PORT",
        config.analytics.vector_port ?? 0,
        "analytics.vector_port",
        projectEnvValues,
      ),
    );

    // Same gap for Supavisor's pooler fields — Go's `Config.Load` applies
    // `SUPABASE_DB_POOLER_*` generically (`pkg/config/config.go:580-586`), regardless of whether
    // `db start` itself ever reads them: it never builds the pooler container. All four throw
    // synchronously on a malformed override — wrapped so a bad value fails as a typed
    // `LegacyDbConfigLoadError` instead of an untyped Effect defect. Discarded.
    yield* wrapDbConfigOverride("db.pooler.port", () =>
      legacyEnvOverridePort(
        "SUPABASE_DB_POOLER_PORT",
        config.db.pooler.port,
        "db.pooler.port",
        projectEnvValues,
      ),
    );
    yield* wrapDbConfigOverride("db.pooler.pool_mode", () =>
      legacyEnvOverridePoolMode(config.db.pooler.pool_mode, projectEnvValues),
    );
    yield* wrapDbConfigOverride("db.pooler.default_pool_size", () =>
      legacyEnvOverrideDefaultPoolSize(config.db.pooler.default_pool_size, projectEnvValues),
    );
    yield* wrapDbConfigOverride("db.pooler.max_client_conn", () =>
      legacyEnvOverrideMaxClientConn(config.db.pooler.max_client_conn, projectEnvValues),
    );

    // Same gap for `edge_runtime.policy` (an enum via `UnmarshalText`) and
    // `edge_runtime.inspector_port` (a plain `uint`) — decoded in the same unconditional
    // `Config.Load` pass (`pkg/config/config.go:749-756,777`), regardless of whether `db start`
    // itself ever reads them: it never builds the Edge Runtime container. Discarded.
    // `edge_runtime.inspector_port` is the exact field flagged by the review thread this battery
    // closes (review: PRRT_kwDOErm0O86VlOHQ).
    yield* wrapDbConfigOverride("edge_runtime.policy", () =>
      legacyEnvOverrideEdgeRuntimePolicy(config.edge_runtime.policy, projectEnvValues),
    );
    yield* wrapDbConfigOverride("edge_runtime.inspector_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
        config.edge_runtime.inspector_port,
        "edge_runtime.inspector_port",
        projectEnvValues,
      ),
    );

    // Same gap for Realtime's `ip_version` (an enum via `UnmarshalText`) and
    // `max_header_length` (a plain `uint`) — decoded in the same unconditional `Config.Load`
    // pass as `edge_runtime.inspector_port` above (`pkg/config/config.go:252-253`), regardless
    // of whether this eager battery itself ever reads them: they're only otherwise consumed by
    // `legacyResolveDbBootstrapConfig` below, which never runs on the already-running
    // short-circuit right after this block (review: PRRT_kwDOErm0O86VmHkl).
    yield* wrapDbConfigOverride("realtime.ip_version", () =>
      legacyEnvOverrideRealtimeIpVersion(config.realtime.ip_version, projectEnvValues),
    );
    yield* wrapDbConfigOverride("realtime.max_header_length", () =>
      legacyEnvOverrideRealtimeMaxHeaderLength(config.realtime.max_header_length, projectEnvValues),
    );

    // Go's AssertSupabaseDbIsRunning: if the db container is already up, print to
    // stderr and return nil (exit 0). Already native — see this module's header. Runs AFTER
    // the config load/validation above, matching Go's `start.Run` (`flags.LoadConfig` before
    // `AssertSupabaseDbIsRunning`, `internal/db/start/start.go:45-47`).
    const running = yield* legacyIsLocalDbRunning(
      spawner,
      fs,
      path,
      cliConfig.workdir,
      Option.getOrUndefined(cliConfig.projectId),
    );
    if (running) {
      if (output.format === "text") {
        yield* output.raw("Postgres database is already running.\n", "stderr");
      } else {
        yield* output.success("Postgres database is already running.", {
          status: "already-running",
        });
      }
      return;
    }

    // Resolve a relative `--from-backup` against the CALLER's cwd, mirroring Go's
    // `StartDatabase` (`filepath.Join(utils.CurrentDirAbs, fromBackup)`, start.go:160-161)
    // where `CurrentDirAbs` is captured before `ChangeWorkDir`.
    const fromBackupFlag = Option.getOrUndefined(flags.fromBackup);
    // An empty `--from-backup ""` is a normal no-backup start in Go (`len(fromBackup) == 0`),
    // so treat it as absent rather than joining it to a directory path.
    const fromBackup =
      fromBackupFlag === undefined || fromBackupFlag === ""
        ? undefined
        : path.isAbsolute(fromBackupFlag)
          ? fromBackupFlag
          : path.join(runtimeInfo.cwd, fromBackupFlag);

    // Not running → bring up the container natively. `db start`'s OWN lean prelude:
    // config values (via `legacyResolveLocalConfigValues`, matching `stop`/`status`'s own
    // resolver) plus the shared `legacyResolveDbBootstrapConfig` derivation `supabase
    // start` also uses — deliberately narrower than `supabase start`'s own prelude: no
    // `--exclude`, no image pre-pull for any other service, no JWT/JWKS/image resolution
    // beyond what Postgres and its own fresh-volume setup jobs need.
    // Go's `viper.GetBool("EXPERIMENTAL")` (`internal/migration/apply/apply.go:19`), read deep
    // inside `legacyStartDatabase`'s fresh-volume setup pipeline — resolved here (project `.env`
    // aware, like `db reset`'s identical gate) so it can be threaded straight through.
    const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnvValues);

    const values = yield* Effect.try({
      try: () =>
        legacyResolveLocalConfigValues(
          config,
          hostname,
          cliConfig.workdir,
          projectEnvValues,
          loaded?.document,
        ),
      catch: (cause) =>
        new LegacyDbConfigLoadError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    const bootstrapConfig = yield* legacyResolveDbBootstrapConfig(
      fs,
      path,
      { config, projectEnvValues, workdir: cliConfig.workdir },
      (message) => new LegacyDbConfigLoadError({ message }),
    );

    // Go's `DockerStart` forces every container's network mode (and the network it creates)
    // to `--network-id` when set, ahead of the generated `supabase_network_<project>` fallback
    // (`docker.go:379-383`) — and `--network-id` falls back to the `SUPABASE_NETWORK_ID`
    // shell/project-dotenv env var when the flag itself is omitted, via the same
    // `viper`/`AutomaticEnv` mechanism as `SUPABASE_YES`/`SUPABASE_EXPERIMENTAL` (review:
    // PRRT_kwDOErm0O86VlqIL; see {@link legacyResolveNetworkId}'s doc comment for why this is NOT
    // the same freeze-at-package-init shape as `utils.Config.Hostname`).
    const networkId = legacyResolveNetworkId(
      Option.getOrUndefined(networkIdFlag),
      projectId,
      projectEnvValues,
    );
    // Go's `DockerStart` unconditionally appends the Linux-only
    // `host.docker.internal:host-gateway` extra host for every container it starts
    // (`docker_linux.go`; empty on darwin/windows, where Docker Desktop already resolves that
    // hostname).
    const extraHosts =
      runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
    const isBitbucketPipeline = legacyIsBitbucketPipeline();
    const startOpts: LegacyStartContainerOpts = {
      projectId,
      isBitbucketPipeline,
      workdir: cliConfig.workdir,
      extraHosts,
    };

    const dbContainerId = localDbContainerId(projectId);
    const filterValue = legacyCliProjectFilterValue(projectId);

    // Go's `utils.NoBackupVolume` package var — assigned by `legacyStartDatabase`'s own
    // pre-create volume-existence check; defaults to `false` (matching Go's zero value) so a
    // rollback triggered by an earlier failure (e.g. network creation) never deletes a volume
    // this run never confirmed was fresh.
    let isFreshVolume = false;

    // Runs the exact Go `StartDatabase` sequence (network -> volume probe -> container
    // create+start -> health wait -> fresh-volume setup -> `_current_branch`) — shared with
    // `supabase start`, see `legacyStartDatabase`'s own header. Any failure rolls back via the
    // SAME `Effect.onError` wrapper `supabase start` uses (not `tapError` — see
    // `legacyRollbackStart`'s own doc comment for why `onError` is required), matching Go's
    // `Run`, which calls `DockerRemoveAll` on ANY `StartDatabase` failure (`start.go:54-59`).
    yield* legacyStartDatabase(spawner, {
      fs,
      path,
      workdir: cliConfig.workdir,
      projectId,
      networkId,
      hostname,
      dbContainerId,
      dbPort: values.dbPort,
      containerOpts: startOpts,
      postgresSpec: {
        db: {
          ...config.db,
          port: values.dbPort,
          major_version: bootstrapConfig.majorVersion,
          settings: legacyResolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues),
        },
        experimental: {
          ...config.experimental,
          orioledb_version: bootstrapConfig.orioledbVersion,
          s3_host: bootstrapConfig.s3Host,
          s3_region: bootstrapConfig.s3Region,
          s3_access_key: bootstrapConfig.s3AccessKey,
          s3_secret_key: bootstrapConfig.s3SecretKey,
        },
        jwtSecret: values.jwtSecret,
        jwtExpiry: values.authJwtExpiry,
        projectId,
        networkId,
        configImage: bootstrapConfig.postgresImage,
        rootKey: values.rootKey,
        fromBackup,
      },
      // Go's `db start` never pre-pulls any OTHER service's image (it has no
      // `ensureImagesCached`-equivalent pre-pull pass at all — `internal/start/start.go`'s own
      // pre-pull is top-level-`start`-only) — only the `db` container's own image, resolved
      // lazily, right where Go's `DockerStart` would resolve it internally
      // (`DockerResolveImageIfNotCached`, `internal/utils/docker.go:363-365`).
      resolvePostgresImage: legacyEnsureImagesCached(
        spawner,
        [bootstrapConfig.postgresImage],
        projectEnvValues,
      ).pipe(
        Effect.map(
          (resolved) =>
            resolved.get(bootstrapConfig.postgresImage) ?? bootstrapConfig.postgresImage,
        ),
      ),
      dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
      setup: {
        majorVersion: bootstrapConfig.majorVersion,
        experimental,
        config: {
          ...config,
          realtime: {
            ...config.realtime,
            enabled: bootstrapConfig.realtimeEnabledForSetup,
            ip_version: bootstrapConfig.realtimeIpVersion,
            max_header_length: bootstrapConfig.realtimeMaxHeaderLength,
          },
          storage: {
            ...config.storage,
            enabled: bootstrapConfig.storageEnabledForSetup,
            file_size_limit: bootstrapConfig.storageFileSizeLimit,
          },
          auth: {
            ...config.auth,
            enabled: bootstrapConfig.authEnabledForSetup,
          },
        },
        dbUrl: values.dbUrl,
        jwtSecret: values.jwtSecret,
        // Go's `initSchema15`'s realtime job resolves JWKS itself, LOCALLY, gated on
        // `Realtime.Enabled` (`internal/db/start/start.go:337-341`) — unlike `supabase
        // start`'s OWN unconditional, up-front `ResolveJWKS` call (which also feeds the
        // long-running Realtime/GoTrue/PostgREST containers `db start` never creates).
        // `legacyStartDatabase` only evaluates this Effect when reached AND
        // `realtimeEnabledForSetup` — see its own header for why this is lazy.
        jwks: Effect.tryPromise({
          try: () =>
            legacyResolveLocalJwks(config, cliConfig.workdir, values.jwtSecret, projectEnvValues),
          catch: (cause) =>
            new LegacyDbConfigLoadError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
        apiUrl: values.apiUrl,
        authExternalUrl: legacyResolveAuthExternalUrl(loaded?.document, projectEnvValues),
        siteUrl: values.authSiteUrl,
        anonKey: values.anonKey,
        serviceRoleKey: values.serviceRoleKey,
        storageTargetMigration: bootstrapConfig.storageTargetMigration,
        realtimeEnabledForSetup: bootstrapConfig.realtimeEnabledForSetup,
        storageEnabledForSetup: bootstrapConfig.storageEnabledForSetup,
        authEnabledForSetup: bootstrapConfig.authEnabledForSetup,
        serviceVersionOverrides: bootstrapConfig.serviceVersionOverrides,
        projectEnvValues,
        debug,
      },
      onFreshVolumeResolved: (resolved) => {
        isFreshVolume = resolved;
      },
    }).pipe(
      Effect.onError(() =>
        legacyRollbackStart(spawner, filterValue, isFreshVolume, cliConfig.workdir),
      ),
    );

    if (output.format !== "text") {
      yield* output.success("Started local database.", { status: "started" });
    }
  });

  // db start is local-only — no project ref, so no linked-project cache write.
  // Telemetry still flushes on success and failure (Go's PersistentPostRun).
  yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
