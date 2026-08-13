/**
 * The local-container-bring-up prelude shared by `db start`
 * (`commands/db/start/start.handler.ts`), `db reset`
 * (`commands/db/reset/reset.handler.ts`, via `reset-local-database.ts`), and
 * `db diff`/`db pull`'s shadow-database provisioning (CLI-1956): load the local
 * project context, resolve config values + the `LegacyDbBootstrapConfig`
 * derivation, the container's network id/opts/id, the Postgres container-spec
 * fields common to every caller, the lazy image-resolve `Effect`, and the
 * `LegacyFreshDbSetupInput` `setup` object `legacyRunFreshDbSetup` needs. Hoisted
 * here (CLI-1955 review follow-up) — `db start`/`db reset` used to each run an
 * independently-typed ~130-line copy of this exact sequence, with no test
 * comparing them.
 *
 * Deliberately does NOT include the callers' genuinely divergent parts, which stay at each
 * call site instead of being forced into this shared shape:
 *  - `db start`'s `fromBackup` (spliced into its OWN `postgresSpec` on top of
 *    {@link LegacyLocalDbContainerInputs.postgresSpecBase}) and its `isFreshVolume`/`filterValue`
 *    rollback tracking — `db reset` has neither concept at all (a reset never rolls back, and its
 *    volume is always fresh, having just been removed).
 *  - `db reset`'s resolved `version`/`seedFlags` (passed straight to `legacyRecreateLocalDatabase`,
 *    not part of this prelude) and its OWN, separately-resolved `--experimental` gate: `db reset`
 *    must resolve `--experimental` BEFORE this prelude ever runs (it gates the remote-target
 *    Go-delegation decision too, reached before `cfg.isLocal` is even known), via the Go-parity
 *    nested-env walk (`legacyLoadProjectEnv`/`legacyResolveExperimentalWithProjectEnv`) — a
 *    deliberately different mechanism than the `@supabase/config`-backed
 *    `context.projectEnvValues` this function resolves `experimental` from (see
 *    {@link LegacyLocalDbContainerInputs.experimental}'s own doc comment). `db reset`'s caller
 *    overrides `setup.experimental` with its own earlier-resolved value rather than using this
 *    function's, to preserve that pre-existing behavior exactly.
 */

import { Effect, FileSystem, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { legacyResolveExperimentalWithProjectEnv } from "../../../shared/legacy/global-flags.ts";
import { LegacyDbConfigLoadError } from "../legacy-db-config.errors.ts";
import { localDbContainerId } from "../legacy-docker-ids.ts";
import { resolveDockerNetworkMode } from "../../../shared/functions/functions-docker.ts";
import { legacyViperEnvStringWithProjectFallback } from "../../../shared/legacy/legacy-viper-env.ts";
import { legacyIsBitbucketPipeline } from "../legacy-bitbucket-pipeline.ts";
import {
  legacyResolveAuthExternalUrl,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveLocalConfigValues,
  legacyResolveLocalJwks,
  type LegacyLocalConfigValues,
} from "../legacy-local-config-values.ts";
import {
  legacyLoadLocalProjectContext,
  type LegacyLocalProjectContext,
} from "../legacy-local-project-context.ts";
import {
  legacyResolveDbBootstrapConfig,
  type LegacyDbBootstrapConfig,
} from "./bootstrap-config.ts";
import type { LegacyFreshDbSetupInput } from "./db-setup.ts";
import type { LegacyContainerOpts } from "./container-lifecycle.ts";
import { legacyEnsureImagesCached, type LegacyImagePrepullError } from "./image-prepull.ts";
import type { LegacyPostgresStartServiceInput } from "./postgres.service.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Everything {@link legacyBuildLocalDbContainerInputs} resolves for its two real callers. */
export interface LegacyLocalDbContainerInputs {
  readonly context: LegacyLocalProjectContext;
  readonly values: LegacyLocalConfigValues;
  readonly bootstrapConfig: LegacyDbBootstrapConfig;
  /** Go's `DockerStart`-forced `--network-id`, or the generated `supabase_network_<project>` fallback. */
  readonly networkId: string;
  readonly containerOpts: LegacyContainerOpts;
  /** `localDbContainerId(projectId)` — also this project's volume name and the internal Docker network name. */
  readonly dbContainerId: string;
  /**
   * The Postgres container-spec fields common to BOTH callers — `db start` splices its own
   * `fromBackup` on top; `db reset` (which has no `fromBackup` concept) passes this straight
   * through as its whole `postgresSpec`.
   */
  readonly postgresSpecBase: Omit<LegacyPostgresStartServiceInput, "image" | "fromBackup">;
  /** Lazy — evaluated right where Go's `DockerStart` would resolve the `db` container's own image. */
  readonly resolvePostgresImage: Effect.Effect<string, LegacyImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /**
   * `--experimental`/`SUPABASE_EXPERIMENTAL`, resolved from THIS prelude's own
   * {@link LegacyLocalProjectContext.projectEnvValues} (the `@supabase/config`-backed reader) —
   * matches `db start`'s own need exactly (it has no earlier use for this gate). `db reset`
   * already resolves its own `experimental` earlier, from the Go-parity nested-env walk
   * (`legacyLoadProjectEnv`), because it needs the gate before this prelude ever runs (to decide
   * Go-delegation for the remote target too) — its caller overrides {@link
   * LegacyFreshDbSetupInput.experimental} with that earlier value instead of using this field, to
   * preserve that pre-existing divergence exactly. See this module's own header.
   */
  readonly experimental: boolean;
  readonly setup: LegacyFreshDbSetupInput<LegacyDbConfigLoadError>;
}

/**
 * Builds {@link LegacyLocalDbContainerInputs} — see this module's header for the full call
 * order and for which parts are deliberately excluded (kept at each call site instead).
 *
 * Loads its own {@link LegacyLocalProjectContext} via {@link legacyLoadLocalProjectContext}
 * UNLESS the caller passes {@link preloadedContext} — see that parameter's own doc comment for
 * why `db start`'s handler must pass one (a double-print bug: `@supabase/config`'s
 * `loadProjectConfig` unconditionally prints deprecated-config-section WARN lines to stderr,
 * and `db start` already loads a context of its own, eagerly, ahead of this function, matching
 * Go's single `flags.LoadConfig` call in `start.Run` (`apps/cli-go/internal/db/start/
 * start.go:45`)).
 */
export const legacyBuildLocalDbContainerInputs = (
  spawner: Spawner,
  workdir: string,
  networkIdFlag: Option.Option<string>,
  platform: string,
  debug: boolean,
  // The resolved `--linked` ref, when the caller already has one (`db diff`/`db pull` —
  // CLI-1956) — threaded straight through to `legacyLoadLocalProjectContext` so the shadow's
  // OWN container-spec fields (image, `db.major_version`, JWT secret, root key,
  // `db.settings`, service enabled-for-setup flags) reflect the matching `[remotes.<ref>]`
  // override, the same way `legacyReadDbToml(..., ref)` already does for those commands'
  // other config read. `db start`/`db reset` never pass this — see that function's own doc
  // comment.
  projectRef?: string,
  // The `remoteOverrideKeys` the caller's OWN, separate `legacyReadDbToml(..., ref)` read
  // already computed for the SAME matched `[remotes.<ref>]` block (`@supabase/config`'s
  // `loadProjectConfig`, used by `legacyLoadLocalProjectContext` just above, merges the
  // remote block's VALUES but tracks none of which keys it set) — threaded into
  // `legacyResolveDbBootstrapConfig`/`legacyResolveDbSettingsEnvOverrides` AND
  // `legacyResolveLocalConfigValues` below so a remote-set field (e.g. `db.major_version`,
  // `auth.jwt_secret`, `db.root_key`) isn't re-overridden by a conflicting `SUPABASE_*` env
  // var (review: PRRT_kwDOErm0O86W2LL4, PRRT_kwDOErm0O86W2tRi). Go's `mergeRemoteConfig`
  // installs remote leaves at viper's OVERRIDE tier, above `AutomaticEnv`
  // (`apps/cli-go/pkg/config/config.go:718-730`).
  // `db start`/`db reset` never pass a `projectRef` above, so they never need this either.
  remoteOverrideKeys?: ReadonlySet<string>,
  // `db start`'s handler — the only real caller that already has a
  // {@link LegacyLocalProjectContext} loaded in scope BEFORE calling this function, since it
  // must eagerly load+validate config ahead of its own "is Postgres already running"
  // short-circuit (matching Go's single `flags.LoadConfig` call, `start.go:45`, which also runs
  // ahead of `AssertSupabaseDbIsRunning`, `start.go:45-47`). When provided, this function uses
  // it AS-IS instead of calling `legacyLoadLocalProjectContext(workdir, mapError, projectRef)`
  // again — the call is skipped entirely, not just its result discarded, because that reload is
  // the one genuinely observable side effect this function would otherwise repeat:
  // `@supabase/config`'s `loadProjectConfig` unconditionally prints deprecated-`[inbucket]`/
  // deprecated-`auth.external.{linkedin,slack}` WARN lines to stderr (`packages/config/src/
  // io.ts:705-710,792-797`), so reloading would print each warning TWICE for one `db start`
  // invocation where Postgres isn't already running, instead of once like Go — whose entire
  // config load is a single package-level-singleton pass, with no second `Config.Load` call
  // anywhere in `db start`'s call graph to double the print.
  //
  // PRECONDITION (not enforced here — see this module's header for why `db start`/`db reset`
  // never pass a `projectRef` above, so there is nothing to reconcile): the preloaded context
  // must correspond to the SAME `workdir`/`projectRef` this call would otherwise have passed to
  // `legacyLoadLocalProjectContext` itself. That's only ever true today for a caller — `db
  // start` — that never passes `projectRef` at all.
  preloadedContext?: LegacyLocalProjectContext,
): Effect.Effect<
  LegacyLocalDbContainerInputs,
  LegacyDbConfigLoadError,
  FileSystem.FileSystem | Path.Path | GlobalFlag.Setting.Identifier<"experimental"> | CliArgs
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mapError = (message: string) => new LegacyDbConfigLoadError({ message });

    const context =
      preloadedContext ?? (yield* legacyLoadLocalProjectContext(workdir, mapError, projectRef));
    const { config, projectEnvValues, loaded, hostname, projectId } = context;
    // Go's `viper.GetBool("EXPERIMENTAL")` (`internal/migration/apply/apply.go:19`), read deep
    // inside `legacyRunFreshDbSetup`'s fresh-volume setup pipeline — see this field's own doc
    // comment for why `db reset`'s caller overrides it instead of using it directly.
    const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnvValues);

    const values = yield* Effect.try({
      try: () =>
        legacyResolveLocalConfigValues(
          config,
          hostname,
          workdir,
          projectEnvValues,
          loaded?.document,
          remoteOverrideKeys,
        ),
      catch: (cause) => mapError(cause instanceof Error ? cause.message : String(cause)),
    });

    const bootstrapConfig = yield* legacyResolveDbBootstrapConfig(
      fs,
      path,
      { config, projectEnvValues, workdir, remoteOverrideKeys },
      mapError,
    );

    // Go's `DockerStart` forces every container's network mode (and the network it creates) to
    // `--network-id` when set, ahead of the generated `supabase_network_<project>` fallback
    // (`docker.go:379-383`) — and `--network-id` falls back to the `SUPABASE_NETWORK_ID`
    // shell/project-dotenv env var ONLY when the flag was never passed, via the same
    // `viper`/`AutomaticEnv` mechanism as `SUPABASE_YES`/`SUPABASE_EXPERIMENTAL` (review:
    // PRRT_kwDOErm0O86VlqIL; unlike `utils.Config.Hostname`, viper re-reads the dotenv-merged
    // env fresh at `DockerStart`'s own call site, not at package init). See
    // {@link resolveDockerNetworkMode}'s doc comment for the full 3-way flag/env precedence.
    const networkId = resolveDockerNetworkMode({
      explicit: Option.getOrUndefined(networkIdFlag),
      envOverride: legacyViperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnvValues),
      projectId,
    });
    // Go's `DockerStart` unconditionally appends the Linux-only `host.docker.internal:host-gateway`
    // extra host for every container it starts (`docker_linux.go`; empty on darwin/windows, where
    // Docker Desktop already resolves that hostname).
    const extraHosts = platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
    const containerOpts: LegacyContainerOpts = {
      projectId,
      isBitbucketPipeline: legacyIsBitbucketPipeline(),
      workdir,
      extraHosts,
    };
    const dbContainerId = localDbContainerId(projectId);

    const postgresSpecBase: Omit<LegacyPostgresStartServiceInput, "image" | "fromBackup"> = {
      db: {
        ...config.db,
        port: values.dbPort,
        major_version: bootstrapConfig.majorVersion,
        settings: legacyResolveDbSettingsEnvOverrides(
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
      configImage: bootstrapConfig.postgresImage,
      rootKey: values.rootKey,
    };

    const resolvePostgresImage = legacyEnsureImagesCached(
      spawner,
      [bootstrapConfig.postgresImage],
      projectEnvValues,
    ).pipe(
      Effect.map(
        (resolved) => resolved.get(bootstrapConfig.postgresImage) ?? bootstrapConfig.postgresImage,
      ),
    );

    const setup: LegacyFreshDbSetupInput<LegacyDbConfigLoadError> = {
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
      // `Realtime.Enabled` (`internal/db/start/start.go:337-341`) — `legacyRunFreshDbSetup` only
      // evaluates this Effect when reached AND `realtimeEnabledForSetup`.
      jwks: Effect.tryPromise({
        try: () =>
          legacyResolveLocalJwks(
            config,
            workdir,
            values.jwtSecret,
            projectEnvValues,
            remoteOverrideKeys,
          ),
        catch: (cause) => mapError(cause instanceof Error ? cause.message : String(cause)),
      }),
      apiUrl: values.apiUrl,
      authExternalUrl: legacyResolveAuthExternalUrl(
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
