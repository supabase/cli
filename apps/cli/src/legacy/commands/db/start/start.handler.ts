import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
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
  localDbContainerId,
  localNetworkId,
} from "../../../shared/legacy-docker-ids.ts";
import {
  legacyEnvOverrideBool,
  legacyResolveAuthEmail,
  legacyResolveAuthExternalUrl,
  legacyResolveAuthMfa,
  legacyResolveAuthSms,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveGotrueSessions,
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

  const body = Effect.gen(function* () {
    // Go's `flags.LoadConfig(fsys)` runs first thing in `start.Run`
    // (`internal/db/start/start.go:45`): a missing config is tolerated (defaults), but
    // a present config that is malformed, references an undecryptable `encrypted:`
    // secret, or fails Validate aborts before any container work. `legacyCheckDbToml`
    // is that exact load+validate — call it here (not via `legacyIsLocalDbRunning`'s
    // best-effort read, which swallows config errors) so `db start` fails fast on a
    // broken config.
    yield* legacyCheckDbToml(fs, path, cliConfig.workdir);

    // Go's AssertSupabaseDbIsRunning: if the db container is already up, print to
    // stderr and return nil (exit 0). Already native — see this module's header.
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
    const context = yield* legacyLoadLocalProjectContext(
      cliConfig.workdir,
      (message) => new LegacyDbConfigLoadError({ message }),
    );
    const { config, projectEnvValues, loaded, hostname, projectId } = context;
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

    // Go decodes every `time.Duration` config field — including these 5 — in the same single,
    // unconditional `Config.Load` pass (`mapstructure.StringToTimeDurationHookFunc()`,
    // `pkg/config/config.go:749-756,777`), before `db start` touches Docker at all
    // (`internal/db/start/start.go:45`) — regardless of whether `db start` itself ever reads
    // the field. `db start` never starts GoTrue (only `supabase start` does, whose OWN identical
    // eager-validation block this mirrors — see `commands/start/start.handler.ts`'s
    // `wrapConfigOverride` call sites), so nothing else in this handler ever parses
    // `auth.email`/`auth.sms`/`auth.sessions`/`auth.mfa`'s duration fields — without this, a
    // malformed value would be silently accepted here instead of failing the command, unlike
    // Go. Discarding the parsed values: only the fail-fast behavior matters for this command.
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
    // Go's `(s *sms) validate()` (`config.go:1412-1415`) prints this and downgrades
    // `EnableSignup` to `false` when no provider is enabled — `legacyResolveAuthSms` already
    // applies the downgrade itself, so this only needs to detect whether that branch fired (the
    // user configured `enable_signup = true` with every provider disabled) to reproduce the
    // matching warning, same as `commands/start/start.handler.ts`'s identical check.
    if (
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

    // Go's `DockerStart` forces every container's network mode (and the network it creates)
    // to `--network-id` when set, ahead of the generated `supabase_network_<project>` fallback
    // (`docker.go:379-383`).
    const networkId = Option.isSome(networkIdFlag)
      ? networkIdFlag.value
      : localNetworkId(projectId);
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
