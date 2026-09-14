/**
 * Shared local-container bring-up prelude for `db start`, `db reset`, and the `db diff`/`db pull`
 * shadow database: resolves project context, config values, network/container ids, the common
 * Postgres container-spec fields, and the `FreshDbSetupInput` `setup` object.
 *
 * Callers keep their own divergent parts instead of forcing them into this shared shape: `db
 * start`'s `fromBackup` splice and rollback tracking, and `db reset`'s version/seed flags and
 * separately-resolved `--experimental` gate (needed earlier, before `cfg.isLocal` is known).
 */

import { Effect, FileSystem, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { resolveExperimentalWithProjectEnv } from "../global-flags.ts";
import { DbConfigLoadError } from "../db-config.errors.ts";
import { localDbContainerId } from "../docker-ids.ts";
import { resolveDockerNetworkMode } from "../../shared/functions/functions-docker.ts";
import { viperEnvStringWithProjectFallback } from "../viper-env.ts";
import { isBitbucketPipeline } from "../bitbucket-pipeline.ts";
import {
  resolveAuthExternalUrl,
  resolveDbSettingsEnvOverrides,
  resolveLocalConfigValues,
  resolveLocalJwks,
  type LocalConfigValues,
} from "../local-config-values.ts";
import { loadLocalProjectContext, type LocalProjectContext } from "../local-project-context.ts";
import { resolveDbBootstrapConfig, type DbBootstrapConfig } from "./bootstrap-config.ts";
import type { FreshDbSetupInput } from "./db-setup.ts";
import type { ContainerOpts } from "./container-lifecycle.ts";
import { ensureImagesCached, type ImagePrepullError } from "./image-prepull.ts";
import type { PostgresStartServiceInput } from "./postgres.service.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Everything {@link buildLocalDbContainerInputs} resolves for its two real callers. */
export interface LocalDbContainerInputs {
  readonly context: LocalProjectContext;
  readonly values: LocalConfigValues;
  readonly bootstrapConfig: DbBootstrapConfig;
  /** The forced `--network-id`, or the generated `supabase_network_<project>` fallback. */
  readonly networkId: string;
  readonly containerOpts: ContainerOpts;
  /** Also this project's volume name and internal Docker network name. */
  readonly dbContainerId: string;
  /**
   * Postgres container-spec fields common to both callers: `db start` splices its own
   * `fromBackup` on top; `db reset` passes this straight through as its whole `postgresSpec`.
   */
  readonly postgresSpecBase: Omit<PostgresStartServiceInput, "image" | "fromBackup">;
  /** Lazy: only resolved when the returned Effect actually runs. */
  readonly resolvePostgresImage: Effect.Effect<string, ImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /**
   * `--experimental`, resolved from this prelude's own project env values. `db reset` resolves
   * its own `experimental` earlier — before this prelude runs — and overrides {@link
   * FreshDbSetupInput.experimental} with that value instead of using this field.
   */
  readonly experimental: boolean;
  readonly setup: FreshDbSetupInput<DbConfigLoadError>;
}

/**
 * Builds {@link LocalDbContainerInputs}; see this module's header for callers' divergent parts.
 *
 * Loads its own {@link LocalProjectContext} unless {@link preloadedContext} is passed — see that
 * parameter's doc comment for why `db start` must pass one.
 */
export const buildLocalDbContainerInputs = (
  spawner: Spawner,
  workdir: string,
  networkIdFlag: Option.Option<string>,
  platform: string,
  debug: boolean,
  // The resolved `--linked` ref for the `db diff`/`db pull` shadow database, threaded through
  // so the shadow's container-spec fields reflect the matching `[remotes.<ref>]` override.
  // `db start`/`db reset` never pass this.
  projectRef?: string,
  // Which keys the caller's own `readDbToml(..., ref)` read set from the matched remote block,
  // so a remote-set field isn't overridden again by a conflicting `SUPABASE_*` env var.
  // `db start`/`db reset` never pass a `projectRef`, so they never pass this either.
  remoteOverrideKeys?: ReadonlySet<string>,
  // `db start`'s handler already loads a {@link LocalProjectContext} before calling this
  // function (to validate config ahead of its own "already running" short-circuit). When
  // provided, this function skips its own reload — `@supabase/config`'s `loadCliConfig` prints
  // deprecated-config WARN lines to stderr, so reloading would print each warning twice. Must
  // correspond to the same `workdir`/`projectRef` this call would otherwise use.
  preloadedContext?: LocalProjectContext,
): Effect.Effect<
  LocalDbContainerInputs,
  DbConfigLoadError,
  FileSystem.FileSystem | Path.Path | GlobalFlag.Setting.Identifier<"experimental"> | CliArgs
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mapError = (message: string) => new DbConfigLoadError({ message });

    const context =
      preloadedContext ?? (yield* loadLocalProjectContext(workdir, mapError, projectRef));
    const { config, projectEnvValues, loaded, hostname, projectId } = context;
    const experimental = yield* resolveExperimentalWithProjectEnv(projectEnvValues);

    const values = yield* Effect.try({
      try: () =>
        resolveLocalConfigValues(
          config,
          hostname,
          workdir,
          projectEnvValues,
          loaded?.document,
          remoteOverrideKeys,
        ),
      catch: (cause) => mapError(cause instanceof Error ? cause.message : String(cause)),
    });

    const bootstrapConfig = yield* resolveDbBootstrapConfig(
      fs,
      path,
      { config, projectEnvValues, workdir, remoteOverrideKeys },
      mapError,
    );

    // See {@link resolveDockerNetworkMode} for the full flag/env/fallback precedence.
    const networkId = resolveDockerNetworkMode({
      explicit: Option.getOrUndefined(networkIdFlag),
      envOverride: viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnvValues),
      projectId,
    });
    // Only needed on Linux; Docker Desktop already resolves `host.docker.internal` elsewhere.
    const extraHosts = platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
    const containerOpts: ContainerOpts = {
      projectId,
      isBitbucketPipeline: isBitbucketPipeline(),
      workdir,
      extraHosts,
    };
    const dbContainerId = localDbContainerId(projectId);

    const postgresSpecBase: Omit<PostgresStartServiceInput, "image" | "fromBackup"> = {
      db: {
        ...config.db,
        port: values.dbPort,
        major_version: bootstrapConfig.majorVersion,
        settings: resolveDbSettingsEnvOverrides(
          config.db.settings,
          projectEnvValues,
          remoteOverrideKeys,
        ),
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
      configImage: bootstrapConfig.postgresConfigImage,
      rootKey: values.rootKey,
    };

    const resolvePostgresImage = ensureImagesCached(
      spawner,
      [bootstrapConfig.postgresImage],
      projectEnvValues,
    ).pipe(
      Effect.map(
        (resolved) => resolved.get(bootstrapConfig.postgresImage) ?? bootstrapConfig.postgresImage,
      ),
    );

    const setup: FreshDbSetupInput<DbConfigLoadError> = {
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
      // Lazy: only evaluated when `runFreshDbSetup` reaches realtime setup and it's enabled.
      jwks: Effect.tryPromise({
        try: () =>
          resolveLocalJwks(config, workdir, values.jwtSecret, projectEnvValues, remoteOverrideKeys),
        catch: (cause) => mapError(cause instanceof Error ? cause.message : String(cause)),
      }),
      apiUrl: values.apiUrl,
      authExternalUrl: resolveAuthExternalUrl(
        loaded?.document,
        projectEnvValues,
        remoteOverrideKeys,
      ),
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
    };

    return {
      context,
      values,
      bootstrapConfig,
      networkId,
      containerOpts,
      dbContainerId,
      postgresSpecBase,
      resolvePostgresImage,
      dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
      experimental,
      setup,
    };
  });
