/**
 * The config-derivation prelude Go's `StartDatabase` (`apps/cli-go/internal/db/start/
 * start.go:133-190`) relies on being ALREADY resolved on `utils.Config` by the time it runs
 * (Go's `Config.Load` folds every `SUPABASE_*` override into the single global `Config`
 * struct once, at process start, before either `db start` or `supabase start`'s own `Run`
 * ever executes) — every field here feeds either the Postgres container spec itself or the
 * fresh-volume `SetupLocalDatabase`-equivalent pipeline. Shared by both callers of
 * `legacyStartDatabase` (`./start-database.ts`) so a future Go change to one of these
 * fields' derivation only needs to change in one TS home — see `apps/cli/CLAUDE.md`'s
 * "Hoist Before You Duplicate" rule and CLI-1954's own report for why this was split out
 * from `commands/start/start.handler.ts`.
 *
 * Deliberately NOT included here (stays each caller's own concern, since it's either
 * `supabase start`-only or caller-timing-sensitive — see `start-database.ts`'s header):
 * `--exclude` gate evaluation, JWKS resolution (`supabase start` resolves it once, eagerly,
 * for its long-running containers too; `db start` resolves it lazily, conditionally, deep
 * inside the fresh-volume setup step, matching Go's own `initSchema15`-local
 * `ResolveJWKS` call — the two callers' timing genuinely differs, so `legacyStartDatabase`
 * takes this as a caller-supplied `Effect` instead), the Postgres registry-image resolve
 * (`db start` resolves lazily, per-container; `supabase start` already resolved it as part
 * of its own batched pre-pull before bring-up — same caller-supplied-`Effect` treatment).
 */

import type { ProjectConfig } from "@supabase/config";
import { Effect, type FileSystem, type Path } from "effect";

import type { LocalServiceVersionOverrides } from "../../../shared/services/services.shared.ts";
import { legacyResolveDbImage } from "../legacy-db-image.ts";
import { legacyResolveHealthTimeoutSeconds } from "../legacy-go-duration.ts";
import {
  legacyEnvOverride,
  legacyEnvOverrideBool,
  legacyEnvOverrideMajorVersion,
  legacyEnvOverrideRealtimeIpVersion,
  legacyEnvOverrideRealtimeMaxHeaderLength,
} from "../legacy-local-config-values.ts";
import { legacyReadServiceVersionOverrides } from "../legacy-service-version-overrides.ts";
import { ramInBytes } from "../legacy-size-units.ts";
import { legacyTempPaths } from "../legacy-temp-paths.ts";

export interface LegacyDbBootstrapConfigInput {
  readonly config: ProjectConfig;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  readonly workdir: string;
}

export interface LegacyDbBootstrapConfig {
  readonly majorVersion: number;
  readonly orioledbVersion: string | undefined;
  readonly s3Host: string | undefined;
  readonly s3Region: string | undefined;
  readonly s3AccessKey: string | undefined;
  readonly s3SecretKey: string | undefined;
  /** Go's one-shot fresh-DB setup jobs' own `Enabled` gates — see `start-database.ts`'s header. */
  readonly realtimeEnabledForSetup: boolean;
  readonly storageEnabledForSetup: boolean;
  readonly authEnabledForSetup: boolean;
  readonly realtimeIpVersion: "IPv4" | "IPv6";
  readonly realtimeMaxHeaderLength: number;
  readonly storageFileSizeLimit: ProjectConfig["storage"]["file_size_limit"];
  /** Pre-registry-resolution image reference (`utils.Config.Db.Image`) — the caller still resolves the registry candidate itself, see this module's header. */
  readonly postgresImage: string;
  readonly serviceVersionOverrides: LocalServiceVersionOverrides;
  readonly dbHealthTimeoutSeconds: number;
  readonly storageTargetMigration: string;
}

/**
 * Wraps a synchronous `legacyEnvOverride*` read that throws on a malformed value into a
 * typed failure, matching Go's `Config.Load` hard-failing on a bad Viper decode
 * (`pkg/config/config.go:749-756`) before any Docker work — instead of leaking an untyped
 * Effect defect. Message format (`invalid config for <path>: <cause>`) matches
 * `commands/start/start.handler.ts`'s own identically-shaped `wrapConfigOverride`, which
 * this module doesn't import from (that one stays private to `start.handler.ts`, covering
 * many more start-only fields; duplicating this ~10-line generic wrapper avoids a
 * `legacy/shared/` -> `legacy/commands/start/` dependency for a trivial utility).
 */
function wrapConfigOverride<T, E>(
  dottedFieldPath: string,
  thunk: () => T,
  mapConfigError: (message: string) => E,
): Effect.Effect<T, E> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      mapConfigError(
        `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
}

/**
 * Resolves every field {@link legacyStartDatabase} (`./start-database.ts`) needs from
 * `config`/`projectEnvValues`, in Go's own `Config.Load` sense: values already folded from
 * any `SUPABASE_*` override, ready to feed the Postgres container spec and the fresh-volume
 * setup pipeline. `mapConfigError` lets each caller tag a malformed-override failure with
 * its own command-specific error type — `db start` uses `LegacyDbConfigLoadError`;
 * `supabase start` uses its own `LegacyStartInvalidConfigError`, matching the class its
 * existing tests already assert for these fields — mirroring the `mapConfigLoadError`
 * idiom `legacy-local-project-context.ts`'s `legacyLoadLocalProjectContext` already uses.
 */
export const legacyResolveDbBootstrapConfig = <E>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: LegacyDbBootstrapConfigInput,
  mapConfigError: (message: string) => E,
): Effect.Effect<LegacyDbBootstrapConfig, E> =>
  Effect.gen(function* () {
    const { config, projectEnvValues, workdir } = input;

    // Go's `Config.Load` folds `SUPABASE_DB_MAJOR_VERSION` into `c.Db.MajorVersion` before the
    // image-selection switch runs (`pkg/config/config.go:585-586,819-827`) — every later read of
    // `utils.Config.Db.MajorVersion` sees this same value. Not wrapped: `legacyCheckDbToml`
    // (called by both callers before this function) already validates this override.
    const majorVersion = legacyEnvOverrideMajorVersion(config.db.major_version, projectEnvValues);
    // `experimental.orioledb_version` -> `Config.Db.Image` rewrite (`pkg/config/config.go:
    // 1041-1046`), plus its four sibling S3 fields Go reads into the Postgres container's `S3_*`
    // env alongside it (`apps/cli-go/internal/db/start/start.go:70-77`). Both `legacyEnvOverride`
    // calls never throw (return the override or the configured value verbatim), so no wrap needed.
    const orioledbVersion = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
      config.experimental.orioledb_version,
      projectEnvValues,
    );
    const s3Host = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_HOST",
      config.experimental.s3_host,
      projectEnvValues,
    );
    const s3Region = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_REGION",
      config.experimental.s3_region,
      projectEnvValues,
    );
    const s3AccessKey = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY",
      config.experimental.s3_access_key,
      projectEnvValues,
    );
    const s3SecretKey = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_SECRET_KEY",
      config.experimental.s3_secret_key,
      projectEnvValues,
    );

    // Go's one-shot fresh-DB setup jobs (`initSchema15`) read `utils.Config.
    // {Realtime,Storage,Auth}.Enabled` — the EFFECTIVE, env-overridden value — and run
    // regardless of `--exclude` (`internal/db/start/start.go:270,299,321`) whenever they
    // actually execute. `supabase start` also reads the SAME override for its own `gates.*`
    // (`start.gates.ts`'s `legacyResolveStartGates`, wrapped there too) — this wrap is
    // harmless, redundant belt-and-suspenders for that caller, and the ONLY protection `db
    // start` has (it has no `--exclude`/`gates` equivalent at all).
    const realtimeEnabledForSetup = yield* wrapConfigOverride(
      "realtime.enabled",
      () =>
        legacyEnvOverrideBool(
          "SUPABASE_REALTIME_ENABLED",
          config.realtime.enabled,
          "realtime.enabled",
          projectEnvValues,
        ),
      mapConfigError,
    );
    const storageEnabledForSetup = yield* wrapConfigOverride(
      "storage.enabled",
      () =>
        legacyEnvOverrideBool(
          "SUPABASE_STORAGE_ENABLED",
          config.storage.enabled,
          "storage.enabled",
          projectEnvValues,
        ),
      mapConfigError,
    );
    const authEnabledForSetup = yield* wrapConfigOverride(
      "auth.enabled",
      () =>
        legacyEnvOverrideBool(
          "SUPABASE_AUTH_ENABLED",
          config.auth.enabled,
          "auth.enabled",
          projectEnvValues,
        ),
      mapConfigError,
    );

    // Both the long-running Realtime container (`supabase start` only) AND the PG15+ one-shot
    // Realtime setup job (both callers, via `legacyStartSetupLocalDatabase`) must see the SAME
    // already-overridden values (Go's single `utils.Config.Realtime` source of truth,
    // `internal/start/start.go:922,928`, `internal/db/start/start.go:283,290`).
    const realtimeIpVersion = yield* wrapConfigOverride(
      "realtime.ip_version",
      () => legacyEnvOverrideRealtimeIpVersion(config.realtime.ip_version, projectEnvValues),
      mapConfigError,
    );
    const realtimeMaxHeaderLength = yield* wrapConfigOverride(
      "realtime.max_header_length",
      () =>
        legacyEnvOverrideRealtimeMaxHeaderLength(
          config.realtime.max_header_length,
          projectEnvValues,
        ),
      mapConfigError,
    );

    // Same reasoning for Storage's file-size limit — both the long-running container
    // (`supabase start` only) AND the one-shot storage migrate job (both callers) must see the
    // same already-overridden value (Go's `internal/start/start.go:1004`, `internal/db/start/
    // start.go:307`, both reading the single `utils.Config.Storage.FileSizeLimit`).
    // `@supabase/config`'s schema accepts `file_size_limit` as a plain string — it does not parse
    // the size grammar itself, so a malformed value must be validated eagerly here (Go's
    // `sizeInBytes.UnmarshalText`, `pkg/config/config.go:39-49`, decodes it unconditionally during
    // `Config.Load`, before either caller touches Docker) rather than left to surface only when a
    // container env builder happens to re-parse it.
    const storageFileSizeLimit =
      legacyEnvOverride(
        "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
        config.storage.file_size_limit,
        projectEnvValues,
      ) ?? config.storage.file_size_limit;
    yield* wrapConfigOverride(
      "storage.file_size_limit",
      () => ramInBytes(storageFileSizeLimit),
      mapConfigError,
    );

    // Go's `Config.Load` rewrites `c.Db.Image` from `supabase/.temp/postgres-version` (a
    // linked-project pin written by `supabase link`) BEFORE either caller reads it
    // (`pkg/config/config.go:827-863`) — never fails (a missing/unreadable pin file resolves to
    // the embedded default), so no wrap needed.
    const postgresImage = yield* legacyResolveDbImage(
      fs,
      path,
      workdir,
      majorVersion,
      orioledbVersion,
    );
    // Ditto for `c.Realtime.Image`/`c.Storage.Image`/`c.Auth.Image` — read once, reused by the
    // fresh-DB one-shot setup jobs' images regardless of whether this run's volume turns out to
    // be fresh at all. Never fails, same reasoning.
    const serviceVersionOverrides = yield* legacyReadServiceVersionOverrides(
      fs,
      path,
      workdir,
      majorVersion,
    );

    // Overridden by SUPABASE_DB_HEALTH_TIMEOUT — Go's Config.Load binds this generically before
    // StartDatabase's health wait reads it (pkg/config/config.go:580-586, internal/db/start/
    // start.go:180).
    const dbHealthTimeout = legacyEnvOverride(
      "SUPABASE_DB_HEALTH_TIMEOUT",
      config.db.health_timeout,
      projectEnvValues,
    );
    const dbHealthTimeoutSeconds = yield* Effect.try({
      try: () => legacyResolveHealthTimeoutSeconds(dbHealthTimeout ?? config.db.health_timeout),
      catch: (cause) =>
        mapConfigError(
          `failed to parse config: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });

    // Go's `config.Load` reads `supabase/.temp/storage-migration` (written by `supabase link`)
    // into `Config.Storage.TargetMigration` whenever present (`pkg/config/config.go:844-846`),
    // feeding `DB_MIGRATIONS_FREEZE_AT` for the fresh-DB one-shot Storage migrate job. Any read
    // error (including not-exist) or blank content resolves to "", matching Go's `err == nil &&
    // len(version) > 0` gate — never fails.
    const storageTargetMigration = yield* fs
      .readFileString(legacyTempPaths(path, workdir).storageMigration)
      .pipe(
        Effect.map((content) => content.trim()),
        Effect.orElseSucceed(() => ""),
      );

    return {
      majorVersion,
      orioledbVersion,
      s3Host,
      s3Region,
      s3AccessKey,
      s3SecretKey,
      realtimeEnabledForSetup,
      storageEnabledForSetup,
      authEnabledForSetup,
      realtimeIpVersion,
      realtimeMaxHeaderLength,
      storageFileSizeLimit,
      postgresImage,
      serviceVersionOverrides,
      dbHealthTimeoutSeconds,
      storageTargetMigration,
    };
  });
