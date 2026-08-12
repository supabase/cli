/**
 * Real bring-up for the Edge Runtime container — Go's "Start all functions"
 * block (`apps/cli-go/internal/start/start.go:1101-1108`, deleted in
 * CLI-1966; last present at commit a253ccba2):
 *
 * ```go
 * if utils.Config.EdgeRuntime.Enabled && !isContainerExcluded(utils.Config.EdgeRuntime.Image, excluded) {
 *   dbUrl := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s", dbConfig.User, dbConfig.Password, dbConfig.Host, dbConfig.Port, dbConfig.Database)
 *   if err := serve.ServeFunctions(ctx, "", nil, "", dbUrl, serve.RuntimeOption{}, fsys); err != nil {
 *     return err
 *   }
 *   started = append(started, utils.EdgeRuntimeId)
 * }
 * ```
 *
 * Unlike its 12 siblings in this directory, this module does NOT build a
 * `LegacyStartContainerSpec` for `legacyCreateContainer`
 * (`../../../shared/db-bootstrap/container-lifecycle.ts`) to create+start uniformly. That
 * unification (`docker create`/`docker start`, `-e KEY`-only env with values
 * supplied via the spawned process's own environment) was evaluated against
 * what `shared/functions/serve.ts`'s `startEdgeRuntimeContainer` actually
 * spawns and rejected as NOT a clean mapping:
 *
 *   - `docker-create-args.ts`'s own header explicitly excludes `WorkingDir`
 *     and `Ulimits` from `LegacyStartContainerSpec` ("none of the 13 [other]
 *     call sites... set them") — Edge Runtime needs BOTH (`--workdir`,
 *     `--ulimit nofile=65536:65536`), so "mapping cleanly" would mean
 *     extending the shared spec for a single caller.
 *   - Every other service's env travels as bare `-e KEY` flags whose values
 *     come from the spawned `docker create` process's own environment
 *     (`container-lifecycle.ts`'s `legacyDockerCreateContainer`). Edge
 *     Runtime instead needs an `--env-file` for ordinary secrets AND a
 *     separate bind-mounted, `sh`-sourced multiline-env script for any secret
 *     containing a newline (`docker env-file` is a line-oriented format that
 *     cannot represent one) — a second env-delivery mechanism the shared spec
 *     has no concept of.
 *   - `docker run -d` (one atomic call) vs. `docker create` + `docker start`
 *     (two calls) is a structural argv difference, not a flag-mapping detail.
 *
 * So this module keeps `startEdgeRuntimeContainer`'s direct `docker run -d`
 * exactly as `functions serve` already spawns it (see that module's own doc
 * comment), and exposes {@link legacyStartEdgeRuntimeContainer} as a direct
 * bring-up `Effect` for `start.handler.ts` to call from its own bring-up loop
 * — NOT a spec for `legacyCreateContainer` to create. `start.handler.ts`'s
 * wiring must special-case Edge Runtime's bring-up call, the same way it
 * already special-cases Postgres's (also called directly, not through the
 * generic `buildSpecForService` switch, since it needs its own health-wait
 * pass before the other services start).
 *
 * `SUPABASE_DB_URL` is the one thing that genuinely differs from what
 * `functions serve` sends: standalone `functions serve` hardcodes the `db`
 * network alias (`shared/functions/serve.ts`'s `legacyDefaultServeDbUrl`,
 * matching Go's `restartEdgeRuntime`), but `start`'s own direct call
 * (`start.go:66-72,1103`) uses the real `dbConfig` — the `db` container's own
 * sanitized name and `config.db.password` — exactly like the other 12
 * services' `dbHost`/`dbPassword` derivation
 * (`../../../shared/db-bootstrap/internal-db-connection.ts`). {@link legacyStartEdgeRuntimeContainer}
 * reproduces that real value, not `functions serve`'s alias-based default.
 */

import { Effect, Option } from "effect";

import {
  startEdgeRuntimeContainer,
  type ServeAuthArtifacts,
  type ServeEdgeRuntimeContainerConfig,
} from "../../../../shared/functions/serve.ts";
import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import {
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "../../../shared/db-bootstrap/internal-db-connection.ts";

export interface LegacyEdgeRuntimeBringUpInput {
  /** Go's `Config.ProjectId`, already sanitized — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.EdgeRuntime.Image`, already resolved/pulled by the caller (`image-prepull.ts`/`legacyResolveEdgeRuntimeImage`). */
  readonly image: string;
  /**
   * Go's `cwd`/`utils.CurrentDirAbs` for this call — `cliConfig.workdir` in
   * `start.handler.ts`. Used as `functions serve`'s `projectRoot`/`flagCwd`
   * (no separate "flag cwd" exists for `start`) and to derive `supabaseDir`
   * (`<workdir>/supabase`).
   */
  readonly workdir: string;
  /** `LegacyLocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB host/password (matches every other service builder's own `dbUrl` input). */
  readonly dbUrl: string;
  /** `config.api.port` — `SUPABASE_INTERNAL_HOST_PORT`. */
  readonly apiPort: number;
  /** `config.edge_runtime.policy`. */
  readonly edgeRuntimePolicy: string;
  /** `config.edge_runtime.inspector_port` — only published when `inspectMode` is set, which `start` never does (Go's `serve.RuntimeOption{}` zero value). */
  readonly edgeRuntimeInspectorPort: number;
  /**
   * `config.edge_runtime.secrets`, already unwrapped — keys UPPERCASED (Go's
   * `strings.ToUpper` config-load workaround, `pkg/config/config.go:766-771`),
   * empty and unresolved-`env()` values filtered out (Go's `SHA256 > 0` gate).
   * Build via `shared/functions/serve.ts`'s exported
   * `toPlainEdgeRuntimeConfig(config.edge_runtime).secrets` rather than
   * re-deriving the uppercase/`Redacted`-unwrap/zero-hash-filter logic here.
   */
  readonly edgeRuntimeSecrets: Readonly<Record<string, string>>;
  /**
   * `config.functions`, already unwrapped — build via
   * `shared/functions/serve.ts`'s exported `toPlainFunctionRecord(config.functions)`.
   */
  readonly configDeclaredFunctions: ServeEdgeRuntimeContainerConfig["configDeclaredFunctions"];
  /**
   * The functions directory manifest — build via `@supabase/config`'s
   * `inferFunctionsManifest({ cwd: workdir, config })`, same as
   * `shared/functions/serve.ts`'s own `resolveServeConfig` does.
   */
  readonly configFunctions: ServeEdgeRuntimeContainerConfig["configFunctions"];
  /**
   * The raw, pre-schema `[functions.*]` TOML table — build via
   * `shared/functions/deploy.ts`'s exported `rawFunctionConfigRecord(document)`
   * against the same raw document `start.handler.ts` already loads (its own
   * `context.loaded?.document`).
   */
  readonly rawConfigFunctions: ServeEdgeRuntimeContainerConfig["rawConfigFunctions"];
  /**
   * Every already-resolved secret/key this container needs — `start`'s own
   * `values.{publishableKey,secretKey,jwtSecret,anonKey,serviceRoleKey}` plus
   * `jwks` (`legacyResolveLocalJwks`'s result), NOT independently re-resolved
   * (see this module's header).
   */
  readonly authArtifacts: ServeAuthArtifacts;
  /** The global `--debug` flag. */
  readonly debug: boolean;
  /** `RuntimeInfo.platform`/`process.platform` — gates the Linux-only `--add-host host.docker.internal:host-gateway` flag. */
  readonly platform: NodeJS.Platform;
}

/**
 * Bring up the Edge Runtime container for `start`, delegating the entire
 * `docker run` argv/env assembly to `shared/functions/serve.ts`'s
 * `startEdgeRuntimeContainer` (already ported for `functions serve`) with
 * `start`'s own already-resolved config/secrets in place of that command's
 * independent config-loading pipeline. `start.handler.ts`'s bring-up loop
 * should call this directly (NOT `legacyCreateContainer`) for the Edge Runtime
 * entry in its service list, gated the same way as every other service on
 * `config.edge_runtime.enabled && !isContainerExcluded(...)`.
 *
 * Resolves to the same `StartedRuntime` shape `functions serve` itself
 * gets back. `containerId` is what the caller adds to its post-bring-up
 * health-wait list (pairing it with an `edgeRuntime` gateway on
 * `LegacyWaitForHealthyServicesOptions`, `../../../shared/db-bootstrap/health-check.ts` — the same
 * shape as the existing `postgrest` gateway). `watchSpecs` is
 * `functions serve`-only file-watch plumbing and can be ignored here.
 *
 * `cleanup` (removing the temp env-file/multiline-env-script/serve-main-
 * template files this call writes to the host) is intentionally left to the
 * caller, and the caller must NOT invoke it on a successful bring-up. Unlike
 * every other `start` service (`legacyCreateContainer`'s `restartPolicy:
 * "unless-stopped"`), Go's own Edge Runtime bring-up (`serve.ServeFunctions`,
 * `internal/functions/serve/serve.go:218-241`) sets NO Docker restart policy
 * at all — its lifecycle is deliberately reconciled at the CLI level
 * (`restartEdgeRuntime`, `serve.go:108-133`), not the Docker daemon level —
 * so this container's own `docker run` (`shared/functions/serve.ts`)
 * intentionally omits `--restart` too. Its bind-mounted host paths must
 * still exist for as long as the container itself can be reattached to
 * (e.g. a plain `docker start` by the user, or discovery by a later CLI
 * invocation) — unlike Kong/Postgres/Supavisor's `secretFiles`, which
 * `container-lifecycle.ts`'s `legacyCreateContainer` now `docker cp`s straight
 * into the container instead of staging on host disk (see
 * `legacyCopyStartSecretFileIntoContainer`'s doc comment), Edge Runtime's own
 * bind-mounted env-file/multiline-env-script/serve-main-template artifacts
 * still need this host persistence, since `docker run -d` bind-mounts them
 * rather than copying their content in. `startEdgeRuntimeContainer` (`shared/functions/
 * serve.ts`) already runs `cleanup` internally on any failed or interrupted
 * bring-up (`Effect.onError`, covering the whole staging-write-through-
 * `docker run` window, not just a non-zero exit code), so the caller only
 * needs to leave the returned `cleanup` unused on success.
 */
export const legacyStartEdgeRuntimeContainer = Effect.fn("legacy.start.edgeRuntime")(function* (
  input: LegacyEdgeRuntimeBringUpInput,
) {
  return yield* startEdgeRuntimeContainer({
    config: {
      projectId: input.projectId,
      apiPort: input.apiPort,
      edgeRuntimePolicy: input.edgeRuntimePolicy,
      edgeRuntimeInspectorPort: input.edgeRuntimeInspectorPort,
      edgeRuntimeSecrets: input.edgeRuntimeSecrets,
      configDeclaredFunctions: input.configDeclaredFunctions,
      configFunctions: input.configFunctions,
      rawConfigFunctions: input.rawConfigFunctions,
    },
    authArtifacts: input.authArtifacts,
    dbUrl: legacyStartInternalDbUrl(
      "postgres",
      legacyServiceContainerName("db", input.projectId),
      legacyStartInternalDbPassword(input.dbUrl),
    ),
    image: input.image,
    projectRoot: input.workdir,
    supabaseDir: `${input.workdir}/supabase`,
    flagCwd: input.workdir,
    platform: input.platform,
    debug: input.debug,
    networkId: input.networkId,
    // Go's `start.go:1104` passes `serve.RuntimeOption{}` (its zero value)
    // and an empty `envFilePath`/`nil` `noVerifyJWT`/empty `importMapPath`
    // — `start` has no CLI flags of its own for any of these.
    envFile: Option.none(),
    importMap: Option.none(),
    noVerifyJwt: Option.none(),
    inspectMode: undefined,
    inspectMain: false,
  });
});
