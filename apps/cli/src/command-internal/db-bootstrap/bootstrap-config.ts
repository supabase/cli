/**
 * Resolves the config fields `startDatabase` needs from `config`/`projectEnvValues`, folding in
 * any `SUPABASE_*` override. Shared by `db start` and `supabase start` so each field's derivation
 * has one home.
 *
 * Excludes `--exclude` gate evaluation, JWKS resolution, and the Postgres registry-image resolve:
 * their timing differs between the two callers, so `startDatabase` takes them as a
 * caller-supplied `Effect` instead. See `start-database.ts`.
 */

import type { CliConfig } from "@supabase/config";
import { Effect, type FileSystem, type Path } from "effect";

import type { LocalServiceVersionOverrides } from "../../shared/services/services.shared.ts";
import { makeRemoteWins } from "../db-config.toml-read.ts";
import { resolveDbImage } from "../db-image.ts";
import { resolveHealthTimeoutSeconds } from "../go-duration.ts";
import {
  envOverride,
  envOverrideBool,
  envOverrideMajorVersion,
  envOverrideRealtimeIpVersion,
  envOverrideRealtimeMaxHeaderLength,
  InvalidRealtimeIpVersionEnvOverrideError,
} from "../local-config-values.ts";
import { readServiceVersionOverrides } from "../service-version-overrides.ts";
import { ramInBytes } from "../size-units.ts";
import { tempPaths } from "../temp-paths.ts";

export interface DbBootstrapConfigInput {
  readonly config: CliConfig;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  readonly workdir: string;
  /**
   * Config keys a matched `[remotes.<ref>]` block set at override tier; every `envOverride*` call
   * below must not re-apply a `SUPABASE_*` value for a field this set already covers. Defaults to
   * empty for `db start`/`db reset`, which never resolve a remote block here.
   */
  readonly remoteOverrideKeys?: ReadonlySet<string>;
}

export interface DbBootstrapConfig {
  readonly majorVersion: number;
  readonly orioledbVersion: string | undefined;
  readonly s3Host: string | undefined;
  readonly s3Region: string | undefined;
  readonly s3AccessKey: string | undefined;
  readonly s3SecretKey: string | undefined;
  /** Effective enabled flags read by the one-shot fresh-DB setup jobs, after any override. */
  readonly realtimeEnabledForSetup: boolean;
  readonly storageEnabledForSetup: boolean;
  readonly authEnabledForSetup: boolean;
  readonly realtimeIpVersion: "IPv4" | "IPv6";
  readonly realtimeMaxHeaderLength: number;
  readonly storageFileSizeLimit: CliConfig["storage"]["file_size_limit"];
  /** Pull/create image; the caller still resolves the registry candidate itself. */
  readonly postgresImage: string;
  /** Unprefixed docker.io identity for INITDB version-compare. Never a slim ghcr ref. */
  readonly postgresConfigImage: string;
  readonly serviceVersionOverrides: LocalServiceVersionOverrides;
  readonly dbHealthTimeoutSeconds: number;
  readonly storageTargetMigration: string;
}

/**
 * Wraps a synchronous `envOverride*` read that throws on a malformed value into a typed failure
 * instead of an untyped Effect defect.
 *
 * @param dottedFieldPath - Config path embedded in the error message (`invalid config for
 * <path>: <cause>`).
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
 * Resolves every field {@link startDatabase} needs from `config`/`projectEnvValues`: values
 * already folded with any `SUPABASE_*` override, ready to feed the Postgres container spec and
 * the fresh-volume setup pipeline.
 *
 * @param mapConfigError - Lets each caller tag a malformed-override failure with its own error
 * type.
 */
export const resolveDbBootstrapConfig = <E>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: DbBootstrapConfigInput,
  mapConfigError: (message: string) => E,
): Effect.Effect<DbBootstrapConfig, E> =>
  Effect.gen(function* () {
    const { config, projectEnvValues, workdir } = input;
    const remoteOverrideKeys = input.remoteOverrideKeys ?? new Set<string>();
    const remoteWins = makeRemoteWins(remoteOverrideKeys);

    // Not wrapped: checkDbToml already validates this override. A matched remote block's value
    // wins over a conflicting SUPABASE_DB_MAJOR_VERSION.
    const majorVersion = remoteWins("db.major_version")
      ? config.db.major_version
      : envOverrideMajorVersion(config.db.major_version, projectEnvValues);
    // orioledb_version and the four S3 fields feed the Postgres container's image/env directly.
    // `envOverride` never throws, so these don't need `wrapConfigOverride`. Same remote-over-env
    // precedence as `majorVersion` applies to each.
    const orioledbVersion = remoteWins("experimental.orioledb_version")
      ? config.experimental.orioledb_version
      : envOverride(
          "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
          config.experimental.orioledb_version,
          projectEnvValues,
        );
    const s3Host = remoteWins("experimental.s3_host")
      ? config.experimental.s3_host
      : envOverride("SUPABASE_EXPERIMENTAL_S3_HOST", config.experimental.s3_host, projectEnvValues);
    const s3Region = remoteWins("experimental.s3_region")
      ? config.experimental.s3_region
      : envOverride(
          "SUPABASE_EXPERIMENTAL_S3_REGION",
          config.experimental.s3_region,
          projectEnvValues,
        );
    const s3AccessKey = remoteWins("experimental.s3_access_key")
      ? config.experimental.s3_access_key
      : envOverride(
          "SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY",
          config.experimental.s3_access_key,
          projectEnvValues,
        );
    const s3SecretKey = remoteWins("experimental.s3_secret_key")
      ? config.experimental.s3_secret_key
      : envOverride(
          "SUPABASE_EXPERIMENTAL_S3_SECRET_KEY",
          config.experimental.s3_secret_key,
          projectEnvValues,
        );

    // The one-shot fresh-DB setup jobs use the effective, overridden enabled value and run
    // regardless of `--exclude`. Wrapping here is `db start`'s only protection against a
    // malformed override; it has no `--exclude`/gates equivalent of its own.
    const realtimeEnabledForSetup = yield* wrapConfigOverride(
      "realtime.enabled",
      () =>
        remoteWins("realtime.enabled")
          ? config.realtime.enabled
          : envOverrideBool(
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
        remoteWins("storage.enabled")
          ? config.storage.enabled
          : envOverrideBool(
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
        remoteWins("auth.enabled")
          ? config.auth.enabled
          : envOverrideBool(
              "SUPABASE_AUTH_ENABLED",
              config.auth.enabled,
              "auth.enabled",
              projectEnvValues,
            ),
      mapConfigError,
    );

    // The long-running Realtime container and the one-shot PG15+ setup job must see the same
    // overridden value.
    const realtimeIpVersion = yield* wrapConfigOverride(
      "realtime.ip_version",
      () => {
        // `envOverrideRealtimeIpVersion` reads `process.env` unconditionally, so it can't be
        // called at all when the remote block wins — a raw env var would still beat it. The
        // throw below only narrows the type; the schema already guarantees one of these values.
        if (remoteWins("realtime.ip_version")) {
          const value = config.realtime.ip_version;
          if (value !== "IPv4" && value !== "IPv6") {
            throw new InvalidRealtimeIpVersionEnvOverrideError("realtime.ip_version", value);
          }
          return value;
        }
        return envOverrideRealtimeIpVersion(config.realtime.ip_version, projectEnvValues);
      },
      mapConfigError,
    );
    const realtimeMaxHeaderLength = yield* wrapConfigOverride(
      "realtime.max_header_length",
      () =>
        remoteWins("realtime.max_header_length")
          ? config.realtime.max_header_length
          : envOverrideRealtimeMaxHeaderLength(config.realtime.max_header_length, projectEnvValues),
      mapConfigError,
    );

    // Same reasoning as Realtime's IP version above. `@supabase/config`'s schema stores
    // `file_size_limit` as a plain string without parsing it, so a malformed value must be
    // validated eagerly here rather than surfacing later inside a container env builder.
    const storageFileSizeLimit = remoteWins("storage.file_size_limit")
      ? config.storage.file_size_limit
      : (envOverride(
          "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
          config.storage.file_size_limit,
          projectEnvValues,
        ) ?? config.storage.file_size_limit);
    yield* wrapConfigOverride(
      "storage.file_size_limit",
      () => ramInBytes(storageFileSizeLimit),
      mapConfigError,
    );

    // Reads a `supabase/.temp/postgres-version` pin written by `supabase link`; a missing or
    // unreadable pin falls back to the embedded default, so this never fails.
    const { image: postgresImage, configImage: postgresConfigImage } = yield* resolveDbImage(
      fs,
      path,
      workdir,
      majorVersion,
      orioledbVersion,
    );
    // Read once and reused by the fresh-DB one-shot setup jobs regardless of whether this run's
    // volume turns out to be fresh; never fails.
    const serviceVersionOverrides = yield* readServiceVersionOverrides(
      fs,
      path,
      workdir,
      majorVersion,
    );

    const dbHealthTimeout = remoteWins("db.health_timeout")
      ? config.db.health_timeout
      : envOverride("SUPABASE_DB_HEALTH_TIMEOUT", config.db.health_timeout, projectEnvValues);
    const dbHealthTimeoutSeconds = yield* Effect.try({
      try: () => resolveHealthTimeoutSeconds(dbHealthTimeout ?? config.db.health_timeout),
      catch: (cause) =>
        mapConfigError(
          `failed to parse config: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });

    // Feeds `DB_MIGRATIONS_FREEZE_AT` for the one-shot Storage migrate job. Any read error
    // (including not-exist) or blank content resolves to "".
    const storageTargetMigration = yield* fs
      .readFileString(tempPaths(path, workdir).storageMigration)
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
      postgresConfigImage,
      serviceVersionOverrides,
      dbHealthTimeoutSeconds,
      storageTargetMigration,
    };
  });
