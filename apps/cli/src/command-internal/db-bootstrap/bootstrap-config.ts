/**
 * Resolves the config fields `startDatabase` needs from the effective `config`. Shared by
 * `db start` and `supabase start` so each field's derivation has one home.
 *
 * Excludes `--exclude` gate evaluation, JWKS resolution, and the Postgres registry-image resolve:
 * their timing differs between the two callers, so `startDatabase` takes them as a
 * caller-supplied `Effect` instead. See `start-database.ts`.
 */

import type { CliConfig } from "@supabase/config";
import { Effect, type FileSystem, type Path } from "effect";

import type { LocalServiceVersionOverrides } from "../../shared/services/services.shared.ts";
import { resolveDbImage } from "../db-image.ts";
import { resolveHealthTimeoutSeconds } from "../duration.ts";
import { narrowConfigEnum } from "../local-config-values.ts";
import {
  InvalidServiceVersionTagError,
  readServiceVersionOverrides,
} from "../service-version-overrides.ts";
import { ramInBytes } from "../size-units.ts";
import { tempPaths } from "../../shared/config/temp-paths.ts";

export interface DbBootstrapConfigInput {
  /** The effective config: every override is already applied. */
  readonly config: CliConfig;
  readonly projectEnvValues?: Readonly<Record<string, string>> | undefined;
  readonly workdir: string;
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
 * Wraps a synchronous validation that throws on a malformed value into a typed failure
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
 * Resolves every field {@link startDatabase} needs from the effective `config`, ready to feed the
 * Postgres container spec and the fresh-volume setup pipeline.
 *
 * @param mapConfigError - Lets each caller tag a malformed-value failure with its own error
 * type.
 */
export const resolveDbBootstrapConfig = <E>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: DbBootstrapConfigInput,
  mapConfigError: (message: string) => E,
): Effect.Effect<DbBootstrapConfig, E | InvalidServiceVersionTagError> =>
  Effect.gen(function* () {
    const { config, workdir } = input;

    const majorVersion = config.db.major_version;
    const orioledbVersion = config.db.orioledb_version;
    const { s3_host: s3Host, s3_region: s3Region } = config.experimental;
    const { s3_access_key: s3AccessKey, s3_secret_key: s3SecretKey } = config.experimental;

    const realtimeEnabledForSetup = config.realtime.enabled;
    const storageEnabledForSetup = config.storage.enabled;
    const authEnabledForSetup = config.auth.enabled;
    const realtimeIpVersion = yield* wrapConfigOverride(
      "realtime.ip_version",
      () => narrowConfigEnum("realtime.ip_version", config.realtime.ip_version, ["IPv4", "IPv6"]),
      mapConfigError,
    );
    const realtimeMaxHeaderLength = config.realtime.max_header_length;

    // `@supabase/config`'s schema stores `file_size_limit` as a plain string without parsing it,
    // so a malformed value must be validated eagerly here rather than surfacing later inside a
    // container env builder.
    const storageFileSizeLimit = config.storage.file_size_limit;
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
    // volume turns out to be fresh. A missing pin is skipped; an unusable tag fails.
    const serviceVersionOverrides = yield* readServiceVersionOverrides(
      fs,
      path,
      workdir,
      majorVersion,
    );

    const dbHealthTimeoutSeconds = yield* Effect.try({
      try: () => resolveHealthTimeoutSeconds(config.db.health_timeout),
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
