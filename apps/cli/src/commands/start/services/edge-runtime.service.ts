/**
 * Bring-up for the Edge Runtime container the `start` command launches,
 * gated like its siblings on
 * `config.edge_runtime.enabled && !isContainerExcluded(...)`.
 *
 * Delegates to `functions serve`'s bring-up (`shared/functions/serve.ts`)
 * rather than the shared `createContainer` spec, since Edge Runtime needs
 * `--workdir`/`--ulimit` flags and a secret-delivery mechanism (env-file plus
 * a bind-mounted multiline-env script) that spec can't express.
 * `start.handler.ts` must call {@link startStackEdgeRuntimeContainer} directly, the
 * same way it already special-cases Postgres.
 *
 * `SUPABASE_DB_URL` is the one input that genuinely differs from `functions
 * serve`'s own default: this module derives it from `start`'s real `dbConfig`
 * instead of the network-alias default `functions serve` uses standalone.
 */

import { Effect, Option } from "effect";

import {
  startEdgeRuntimeContainer,
  type ServeAuthArtifacts,
  type ServeEdgeRuntimeContainerConfig,
} from "../../../shared/functions/serve.ts";
import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import {
  startInternalDbPassword,
  startInternalDbUrl,
} from "../../../command-internal/db-bootstrap/internal-db-connection.ts";

export interface EdgeRuntimeBringUpInput {
  /** The sanitized project id — see `serviceContainerName`'s callers. */
  readonly projectId: string;
  /** Docker network to attach to — the `--network-id` override or the project's default network. */
  readonly networkId: string;
  /** Already resolved/pulled by the caller (`resolveEdgeRuntimeImage`). */
  readonly image: string;
  /**
   * Used as both `functions serve`'s `projectRoot` and `flagCwd`, and to
   * derive `supabaseDir` (`<workdir>/supabase`).
   */
  readonly workdir: string;
  /** Reused, not recomputed, to derive the internal DB host/password. */
  readonly dbUrl: string;
  /** `config.api.port`, exposed to the container as `SUPABASE_INTERNAL_HOST_PORT`. */
  readonly apiPort: number;
  /** `config.edge_runtime.policy`. */
  readonly edgeRuntimePolicy: string;
  /** `config.edge_runtime.inspector_port` — only published when `inspectMode` is set, which `start` never does. */
  readonly edgeRuntimeInspectorPort: number;
  /**
   * `config.edge_runtime.secrets`, unwrapped via `shared/functions/serve.ts`'s
   * `toPlainEdgeRuntimeConfig` (keys uppercased, empty/unresolved values filtered).
   */
  readonly edgeRuntimeSecrets: Readonly<Record<string, string>>;
  /** `config.functions`, unwrapped via `shared/functions/serve.ts`'s `toPlainFunctionRecord`. */
  readonly configDeclaredFunctions: ServeEdgeRuntimeContainerConfig["configDeclaredFunctions"];
  /** The functions directory manifest, from `@supabase/config`'s `inferFunctionsManifest({ cwd: workdir, config })`. */
  readonly configFunctions: ServeEdgeRuntimeContainerConfig["configFunctions"];
  /**
   * The raw, pre-schema `[functions.*]` TOML table, from
   * `shared/functions/deploy.ts`'s `rawFunctionConfigRecord(document)`.
   */
  readonly rawConfigFunctions: ServeEdgeRuntimeContainerConfig["rawConfigFunctions"];
  /** Every already-resolved secret/key this container needs; not independently re-resolved here. */
  readonly authArtifacts: ServeAuthArtifacts;
  /** The global `--debug` flag. */
  readonly debug: boolean;
  /** `RuntimeInfo.platform`/`process.platform` — gates the Linux-only `--add-host host.docker.internal:host-gateway` flag. */
  readonly platform: NodeJS.Platform;
}

/**
 * Brings up the Edge Runtime container for `start`, using `start`'s own
 * already-resolved config/secrets in place of `functions serve`'s
 * independent config-loading pipeline. Call this directly from the bring-up
 * loop, not through `createContainer`.
 *
 * `containerId` is added to the caller's post-bring-up health-wait list
 * (paired with an `edgeRuntime` gateway, the same shape as `postgrest`'s).
 * `watchSpecs` is `functions serve`-only file-watch plumbing and can be
 * ignored here.
 *
 * Sets no Docker restart policy — unlike every other `start` service, Edge
 * Runtime's lifecycle is reconciled at the CLI level instead. Leave the
 * returned `cleanup` unused on success: its bind-mounted host files must
 * outlive the call for as long as the container can be reattached to, and
 * `startEdgeRuntimeContainer` already runs `cleanup` on any failed or
 * interrupted bring-up.
 */
export const startStackEdgeRuntimeContainer = Effect.fn("start.edgeRuntime")(function* (
  input: EdgeRuntimeBringUpInput,
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
    dbUrl: startInternalDbUrl(
      "postgres",
      serviceContainerName("db", input.projectId),
      startInternalDbPassword(input.dbUrl),
    ),
    image: input.image,
    projectRoot: input.workdir,
    supabaseDir: `${input.workdir}/supabase`,
    flagCwd: input.workdir,
    platform: input.platform,
    debug: input.debug,
    networkId: input.networkId,
    // `start` has no CLI flags of its own for any of these; all zero values.
    envFile: Option.none(),
    discoverFunctionEnvFiles: false,
    importMap: Option.none(),
    noVerifyJwt: Option.none(),
    inspectMode: undefined,
    inspectMain: false,
  });
});
