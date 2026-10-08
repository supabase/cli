/**
 * Plain local-database start shared by `supabase db start` and the declarative `--local` paths.
 * Self-contained: resolves its own services, reports progress via `output.raw` only, and never
 * flushes telemetry.
 *
 * "Already running" is a success here, and callers print it differently (`db start` prints a
 * message, the declarative seam stays silent), so this returns a
 * {@link StartLocalDatabaseResult} discriminator instead of printing the terminal line itself.
 */

import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { NetworkIdFlag, resolveDebugWithProjectEnv } from "../global-flags.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { checkDbToml } from "../db-config.toml-read.ts";
import { DbConfigLoadError } from "../db-config.errors.ts";
import {
  resolveAuthExternalProviders,
  resolveGotruePasskeyWebauthn,
  resolveLocalConfigValues,
} from "../local-config-values.ts";
import { parseGoDuration, resolveHealthTimeoutSeconds } from "../go-duration.ts";
import { ramInBytes } from "../size-units.ts";
import { goUrlParse } from "../storage-url.ts";
import { loadLocalProjectContext } from "../local-project-context.ts";
import { cliProjectFilterValue } from "../docker-ids.ts";
import { buildLocalDbContainerInputs } from "./local-container-inputs.ts";
import { isLocalDbRunning } from "./local-db-running.ts";
import { rollbackStart } from "./rollback.ts";
import { startDatabase } from "./start-database.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps a synchronous resolver/parser that throws on a malformed config value into a typed
 * `DbConfigLoadError` failure — mirrors `commands/start/start.handler.ts`'s identical
 * `wrapConfigOverride`: config loading hard-fails on a bad decode before any Docker work runs.
 */
function wrapDbConfigOverride<T>(
  dottedFieldPath: string,
  thunk: () => T,
): Effect.Effect<T, DbConfigLoadError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      new DbConfigLoadError({
        message: `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

type StartLocalDatabaseStatus = "already-running" | "started";

interface StartLocalDatabaseResult {
  readonly status: StartLocalDatabaseStatus;
}

/**
 * Starts the local Postgres database, or no-ops when it is already running. See this module's
 * own header for the full design rationale.
 *
 * `fromBackupFlag` is `db start`'s own `--from-backup` value, resolved against the caller's cwd
 * before being passed in; the declarative seam's `ensureLocalDatabaseStarted` always calls with
 * no argument.
 */
export const startLocalDatabase = Effect.fn("DbBootstrap.startLocalDatabase")(function* (
  fromBackupFlag?: string,
) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const networkIdFlag = yield* NetworkIdFlag;

  // Config is loaded first thing: a missing config is tolerated (defaults), but a present config
  // that is malformed, references an undecryptable `encrypted:` secret, or fails validation
  // aborts before any container work. `checkDbToml` does that load+validate, not
  // `isLocalDbRunning`'s best-effort read, which swallows config errors.
  const dbTomlValues = yield* checkDbToml(fs, path, cliSettings.workdir);

  // Threaded into `rollbackStart`'s own teardown (gates its `Pruned …:` stderr reports) and into
  // `buildLocalDbContainerInputs`'s own `setup.debug`, so a failed fresh-volume migrate job tees
  // its own stderr. Resolved with the `SUPABASE_DEBUG` shell/project-`.env` fallback, not the
  // bare flag.
  const debug = yield* resolveDebugWithProjectEnv(dbTomlValues.projectEnv);

  // The rest of config loading — full decode/resolution plus the eager duration-field
  // validation right below — also runs before the already-running check, so a malformed
  // `auth.*` duration field must fail this call even when Postgres is already running.
  const context = yield* loadLocalProjectContext(
    cliSettings.workdir,
    (message) => new DbConfigLoadError({ message }),
  );
  // This same `context` is passed into `buildLocalDbContainerInputs` below as
  // `preloadedContext`; that function returns the same context back verbatim.
  // `hostnameForValidation` here still feeds the discarded `resolveLocalConfigValues` call below.
  const { config, snapshot, hostname: hostnameForValidation } = context;
  const document = snapshot.loaded.document ?? {};

  // Every duration config field is decoded in this same unconditional pass, before Docker is
  // touched or the already-running check runs. The parsed values are discarded; only the
  // fail-fast behavior matters.
  yield* wrapDbConfigOverride("auth.email.max_frequency", () =>
    parseGoDuration(config.auth.email.max_frequency),
  );
  yield* wrapDbConfigOverride("auth.sms.max_frequency", () =>
    parseGoDuration(config.auth.sms.max_frequency),
  );
  if (
    config.auth.enabled &&
    !config.auth.sms.twilio.enabled &&
    !config.auth.sms.twilio_verify.enabled &&
    !config.auth.sms.messagebird.enabled &&
    !config.auth.sms.textlocal.enabled &&
    !config.auth.sms.vonage.enabled &&
    config.auth.sms.enable_signup
  ) {
    yield* output.raw("WARN: no SMS provider is enabled. Disabling phone login\n", "stderr");
  }
  const { timebox, inactivity_timeout: inactivityTimeout } = config.auth.sessions ?? {};
  if (timebox !== undefined) {
    yield* wrapDbConfigOverride("auth.sessions.timebox", () => parseGoDuration(timebox));
  }
  if (inactivityTimeout !== undefined) {
    yield* wrapDbConfigOverride("auth.sessions.inactivity_timeout", () =>
      parseGoDuration(inactivityTimeout),
    );
  }
  yield* wrapDbConfigOverride("auth.mfa.phone.max_frequency", () =>
    parseGoDuration(config.auth.mfa.phone.max_frequency),
  );
  yield* wrapDbConfigOverride("auth.passkey", () => resolveGotruePasskeyWebauthn(document));
  yield* wrapDbConfigOverride("auth.external", () =>
    resolveAuthExternalProviders(asRecord(document["auth"]), config.auth.external),
  );
  yield* wrapDbConfigOverride("storage.file_size_limit", () =>
    ramInBytes(config.storage.file_size_limit),
  );
  yield* wrapDbConfigOverride("db.health_timeout", () =>
    resolveHealthTimeoutSeconds(config.db.health_timeout),
  );

  if (config.studio.enabled && config.studio.port === 0) {
    yield* Effect.fail(
      new DbConfigLoadError({ message: "Missing required field in config: studio.port" }),
    );
  }
  if (config.studio.enabled) {
    yield* Effect.try({
      try: () => goUrlParse(config.studio.api_url),
      catch: (cause) =>
        new DbConfigLoadError({
          message: `Invalid config for studio.api_url: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
  }
  if (config.local_smtp.enabled && config.local_smtp.port === 0) {
    yield* Effect.fail(
      new DbConfigLoadError({ message: "Missing required field in config: local_smtp.port" }),
    );
  }

  // `resolveLocalConfigValues` is the same resolver `buildLocalDbContainerInputs` calls again
  // below to build the real `values`. Calling it eagerly here too forces its internal
  // decode-time throws (auth.captcha, jwt_secret length, signing_keys_path, api.tls cert/key
  // reads, auth.external required fields, email/notification template reads) to surface before
  // the already-running shortcut. The result is discarded; `buildLocalDbContainerInputs` below
  // re-resolves the real values.
  yield* Effect.try({
    try: () =>
      resolveLocalConfigValues(config, hostnameForValidation, cliSettings.workdir, document),
    catch: (cause) =>
      new DbConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  // If the db container is already up, tell the caller and stop here. Runs after the config
  // load/validation above.
  const running = yield* isLocalDbRunning(spawner, fs, path, cliSettings.workdir);
  yield* Effect.annotateCurrentSpan("db.already_running", running);
  if (running) {
    return { status: "already-running" } satisfies StartLocalDatabaseResult;
  }

  // Resolve a relative `--from-backup` against the caller's cwd, captured before any workdir
  // change. An empty `--from-backup ""` is a normal no-backup start, so treat it as absent
  // rather than joining it to a directory path.
  const fromBackup =
    fromBackupFlag === undefined || fromBackupFlag === ""
      ? undefined
      : path.isAbsolute(fromBackupFlag)
        ? fromBackupFlag
        : path.join(runtimeInfo.cwd, fromBackupFlag);

  // Not running → bring up the container natively. `context` (loaded eagerly above) is threaded
  // through as `preloadedContext` so this call reuses it instead of calling
  // `loadLocalProjectContext` a second time, which would double-print deprecated-config-section
  // warnings.
  const inputs = yield* buildLocalDbContainerInputs(
    spawner,
    cliSettings.workdir,
    networkIdFlag,
    runtimeInfo.platform,
    debug,
    undefined,
    context,
  );
  const {
    context: { projectId, hostname },
    values,
    bootstrapConfig,
    networkId,
    containerOpts,
    dbContainerId,
    postgresSpecBase,
    resolvePostgresImage,
    setup,
  } = inputs;

  const filterValue = cliProjectFilterValue(projectId);

  // Assigned by `startDatabase`'s own pre-create volume-existence check; defaults to
  // `false` so a rollback triggered by an earlier failure (e.g. network creation) never
  // deletes a volume this run never confirmed was fresh.
  let isFreshVolume = false;

  // Runs the exact start-database sequence (network -> volume probe -> container create+start
  // -> health wait -> fresh-volume setup -> `_current_branch`) — shared with `supabase start`,
  // see `startDatabase`'s own header. Any failure rolls back via the same `Effect.onError`
  // wrapper `supabase start` uses.
  yield* startDatabase(spawner, {
    fs,
    path,
    workdir: cliSettings.workdir,
    projectId,
    networkId,
    hostname,
    dbContainerId,
    dbPort: values.dbPort,
    containerOpts,
    // `db reset` has no `fromBackup` concept at all, so `postgresSpecBase` omits it.
    postgresSpec: { ...postgresSpecBase, fromBackup },
    // Only the `db` container's own image, resolved lazily, right where it would be
    // resolved internally otherwise — no other service's image is pre-pulled here.
    resolvePostgresImage,
    dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
    setup,
    webhooksEnabled: dbTomlValues.webhooksEnabled,
    onFreshVolumeResolved: (resolved) => {
      isFreshVolume = resolved;
    },
  }).pipe(
    Effect.onError(() =>
      rollbackStart(spawner, filterValue, isFreshVolume, cliSettings.workdir, debug),
    ),
  );

  return { status: "started" } satisfies StartLocalDatabaseResult;
});
