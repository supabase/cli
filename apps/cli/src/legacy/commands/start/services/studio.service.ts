/**
 * Studio env + container spec builder — port of Go's "Start Studio" block
 * (`apps/cli-go/internal/start/start.go:1148-1191`) and its `buildStudioEnv`
 * helper (`start.go:1319-1347`), ported faithfully as {@link legacyBuildStudioEnv}
 * — see `apps/cli-go/internal/start/start_test.go:522 TestBuildStudioEnv`,
 * ported in `studio.service.unit.test.ts`. Gated in Go by `config.studio.enabled`
 * and `!isContainerExcluded(config.studio.image, excluded)` — see
 * `legacy-service-catalog.ts`'s `studio` entry (`excludeKey: "studio"`, gated
 * on `studio.enabled`, depends on pg-meta being healthy/running). Gating,
 * image resolution/pre-pull, and edge-function bind-mount resolution
 * (`serve.PopulatePerFunctionConfigs`, out of scope here — see
 * {@link LegacyStudioContainerInput.functionBinds}) are the caller's job (a
 * future `start.handler.ts`).
 *
 * `workdir`/`containerSnippetsPath`: Go computes `hostSnippetsPath :=
 * filepath.Join(workdir, utils.SnippetsDir)` where `utils.SnippetsDir =
 * filepath.Join("supabase", "snippets")` (`apps/cli-go/internal/utils/misc.go:107`)
 * — a plain top-level `<project>/supabase/snippets` directory, NOT under
 * `supabase/.temp/` (that directory is reserved for Go's own link-state cache,
 * see `legacy-temp-paths.ts`; snippets are user content Studio's SQL Editor
 * reads/writes, meant to persist, not a cache). `containerSnippetsPath` is
 * that host path translated to its in-container mount form
 * (`utils.ToDockerPath` — see {@link legacyToDockerPath}), computed once by
 * {@link legacyBuildStudioContainerSpec} and threaded into both the bind mount
 * and {@link legacyBuildStudioEnv}'s `SNIPPETS_MANAGEMENT_FOLDER`, mirroring
 * Go's `run()` computing it once for both uses.
 */

import { join } from "node:path";

import { legacyToDockerPath } from "../../../shared/legacy-docker-path.ts";
import type { LegacyStartContainerSpec } from "../lib/docker-create-args.ts";

/** Container-internal port Studio listens on — Go's hardcoded `3000/tcp` (`start.go:1166,1174`). */
const STUDIO_CONTAINER_PORT = 3000;

/** Go's `utils.StudioAliases` (`apps/cli-go/internal/utils/config.go:45`) — a fixed, non-configurable constant. */
const STUDIO_NETWORK_ALIASES = ["studio"];

/**
 * Go's `Config.Analytics.ApiKey` default (`pkg/config/config.go:529`,
 * `NewConfig()`'s `Analytics: analytics{ApiKey: "api-key", ...}`). That field
 * is `toml:"-"` (`pkg/config/config.go:307`) — never decoded from
 * `config.toml`, never overridable — so this is always the value regardless of
 * the resolved project config, exactly like `legacy-local-config-values.ts`'s
 * other Go-hardcoded, schema-absent constants (`DEFAULT_DB_PASSWORD`, the S3
 * credential triple).
 */
const LOGFLARE_PRIVATE_ACCESS_TOKEN = "api-key";

export interface LegacyBuildStudioEnvInput {
  /** Go's `dbConfig.Password` (`start.go:1323`) — becomes `POSTGRES_PASSWORD`. */
  readonly dbPassword: string;
  /**
   * Go's `workdir` (`os.Getwd()` in `run()`, `start.go:308`; matches
   * `LegacyCliConfig.workdir`, the already-resolved absolute project root) —
   * `EDGE_FUNCTIONS_MANAGEMENT_FOLDER` is resolved against it
   * (`filepath.Join(workdir, utils.FunctionsDir)`, `start.go:1341`).
   */
  readonly workdir: string;
  /**
   * Go's `containerSnippetsPath` (`start.go:1157`) — becomes
   * `SNIPPETS_MANAGEMENT_FOLDER` verbatim. See this module's doc comment for
   * what it is and how it's derived.
   */
  readonly containerSnippetsPath: string;
  /** Go's `utils.Version` — `CURRENT_CLI_VERSION`. */
  readonly cliVersion: string;
  /** pg-meta's own container name (Go's `utils.PgmetaId`) — `STUDIO_PG_META_URL=http://<name>:8080`. */
  readonly pgMetaContainerName: string;
  /** Kong's own container name (Go's `utils.KongId`) — `SUPABASE_URL=http://<name>:8000`. */
  readonly kongContainerName: string;
  /** Logflare's own container name (Go's `utils.LogflareId`) — `LOGFLARE_URL=http://<name>:4000`. */
  readonly logflareContainerName: string;
  /**
   * `config.studio.api_url`, post-`SUPABASE_STUDIO_API_URL`-override AND
   * post-`Config.Validate`'s host-rewrite (`legacyResolveStudioApiUrl`,
   * `pkg/config/config.go:1074-1078`) — `SUPABASE_PUBLIC_URL`. Distinct from
   * `LegacyLocalConfigValues.studioUrl` (the `http://<hostname>:<port>` value
   * `status` reports). This is NOT simply the raw `studio.api_url` field:
   * under a default config its host (`127.0.0.1`) matches the local hostname,
   * so Go rewrites it to `Config.Api.ExternalUrl` (the Kong URL) before
   * `start` ever reads it — the caller must apply that same rewrite before
   * passing this field in.
   */
  readonly studioApiUrl: string;
  /** `legacyResolveLocalConfigValues(...).jwtSecret` — `AUTH_JWT_SECRET`. */
  readonly jwtSecret: string;
  /** `legacyResolveLocalConfigValues(...).anonKey` — `SUPABASE_ANON_KEY`. */
  readonly anonKey: string;
  /** `legacyResolveLocalConfigValues(...).serviceRoleKey` — `SUPABASE_SERVICE_KEY`. */
  readonly serviceRoleKey: string;
  /** `legacyResolveLocalConfigValues(...).publishableKey` — `SUPABASE_PUBLISHABLE_KEY`. */
  readonly publishableKey: string;
  /** `legacyResolveLocalConfigValues(...).secretKey` — `SUPABASE_SECRET_KEY`. */
  readonly secretKey: string;
  /** `legacyResolveLocalConfigValues(...).storageS3AccessKeyId` — `S3_PROTOCOL_ACCESS_KEY_ID`. */
  readonly s3AccessKeyId: string;
  /** `legacyResolveLocalConfigValues(...).storageS3SecretAccessKey` — `S3_PROTOCOL_ACCESS_KEY_SECRET`. */
  readonly s3SecretAccessKey: string;
  /**
   * `config.studio.openai_api_key`, decrypted/resolved by the caller —
   * `OPENAI_API_KEY`. `undefined` maps to `""`, matching Go's unset `Secret`
   * zero value (`utils.Config.Studio.OpenaiApiKey.Value`).
   */
  readonly openaiApiKey: string | undefined;
  /** `config.api.schemas` — `PGRST_DB_SCHEMAS`, comma-joined. */
  readonly apiSchemas: ReadonlyArray<string>;
  /** `config.api.extra_search_path` — `PGRST_DB_EXTRA_SEARCH_PATH`, comma-joined. */
  readonly apiExtraSearchPath: ReadonlyArray<string>;
  /** `config.api.max_rows` — `PGRST_DB_MAX_ROWS`. */
  readonly apiMaxRows: number;
  /** `legacyEnvOverrideBool`-resolved `analytics.enabled` — `NEXT_PUBLIC_ENABLE_LOGS`. */
  readonly analyticsEnabled: boolean;
  /** `config.analytics.backend`, post-`SUPABASE_ANALYTICS_BACKEND`-override — `NEXT_ANALYTICS_BACKEND_PROVIDER`. */
  readonly analyticsBackend: "postgres" | "bigquery";
}

/**
 * Port of Go's `buildStudioEnv(dbConfig pgconn.Config, workdir,
 * containerSnippetsPath string) []string` (`start.go:1319-1347`). Returns a
 * `KEY -> value` map rather than Go's `KEY=value` string slice —
 * {@link LegacyStartContainerSpec.env}'s own shape, chosen so secret values
 * never round-trip through this process's own `docker create` argv (see that
 * field's doc comment in `docker-create-args.ts`). Pure — no Effect or I/O —
 * so every env var mapping is unit-testable in isolation; ported test:
 * `apps/cli-go/internal/start/start_test.go:522 TestBuildStudioEnv`.
 */
export function legacyBuildStudioEnv(input: LegacyBuildStudioEnvInput): Record<string, string> {
  return {
    CURRENT_CLI_VERSION: input.cliVersion,
    STUDIO_PG_META_URL: `http://${input.pgMetaContainerName}:8080`,
    POSTGRES_PASSWORD: input.dbPassword,
    SUPABASE_URL: `http://${input.kongContainerName}:8000`,
    SUPABASE_PUBLIC_URL: input.studioApiUrl,
    AUTH_JWT_SECRET: input.jwtSecret,
    SUPABASE_ANON_KEY: input.anonKey,
    SUPABASE_SERVICE_KEY: input.serviceRoleKey,
    SUPABASE_PUBLISHABLE_KEY: input.publishableKey,
    SUPABASE_SECRET_KEY: input.secretKey,
    S3_PROTOCOL_ACCESS_KEY_ID: input.s3AccessKeyId,
    S3_PROTOCOL_ACCESS_KEY_SECRET: input.s3SecretAccessKey,
    LOGFLARE_PRIVATE_ACCESS_TOKEN,
    OPENAI_API_KEY: input.openaiApiKey ?? "",
    PGRST_DB_SCHEMAS: input.apiSchemas.join(","),
    PGRST_DB_EXTRA_SEARCH_PATH: input.apiExtraSearchPath.join(","),
    PGRST_DB_MAX_ROWS: String(input.apiMaxRows),
    LOGFLARE_URL: `http://${input.logflareContainerName}:4000`,
    NEXT_PUBLIC_ENABLE_LOGS: String(input.analyticsEnabled),
    NEXT_ANALYTICS_BACKEND_PROVIDER: input.analyticsBackend,
    EDGE_FUNCTIONS_MANAGEMENT_FOLDER: legacyToDockerPath(
      join(input.workdir, "supabase", "functions"),
    ),
    SNIPPETS_MANAGEMENT_FOLDER: input.containerSnippetsPath,
    // Ref: https://github.com/vercel/next.js/issues/51684#issuecomment-1612834913
    HOSTNAME: "0.0.0.0",
    POSTGRES_USER_READ_WRITE: "postgres",
  };
}

export interface LegacyStudioContainerInput {
  /** `config.studio.image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `legacyServiceContainerName("studio", projectId)` — Go's `utils.StudioId`. */
  readonly containerName: string;
  /** Go's `utils.NetId` — the shared Docker network every `start` container joins. */
  readonly networkId: string;
  /** `config.studio.port` — the host port published to `3000/tcp`. */
  readonly port: number;
  /**
   * Go's `serve.PopulatePerFunctionConfigs(workdir, "", nil, fsys)` binds
   * (`start.go:1150`) — the per-enabled-Edge-Function module bind mounts Go
   * resolves from each `supabase/functions/<slug>`'s deploy config. Out of
   * scope for this port (a separate, large functions-deploy-config-parsing
   * concern); pass `[]` until a future edge-functions-serve integration
   * supplies these.
   */
  readonly functionBinds: ReadonlyArray<string>;
  /** Every value {@link legacyBuildStudioEnv} needs, minus the path this builder derives itself. */
  readonly env: Omit<LegacyBuildStudioEnvInput, "containerSnippetsPath">;
}

/**
 * Assembles Studio's {@link LegacyStartContainerSpec}, including the snippets
 * bind mount and its Docker-path form Go derives from `workdir` once
 * (`start.go:1150-1159`) and reuses for both the bind and
 * {@link legacyBuildStudioEnv}'s `SNIPPETS_MANAGEMENT_FOLDER`.
 */
export function legacyBuildStudioContainerSpec(
  input: LegacyStudioContainerInput,
): LegacyStartContainerSpec {
  const hostSnippetsPath = join(input.env.workdir, "supabase", "snippets");
  const containerSnippetsPath = legacyToDockerPath(hostSnippetsPath);

  // Go's `utils.RemoveDuplicates` (`start.go:1159`) — order-preserving dedup;
  // `Set` iteration order matches Go's own first-seen-wins semantics.
  const binds = Array.from(
    new Set([...input.functionBinds, `${hostSnippetsPath}:${containerSnippetsPath}:rw`]),
  );

  return {
    image: input.image,
    containerName: input.containerName,
    env: legacyBuildStudioEnv({ ...input.env, containerSnippetsPath }),
    binds,
    healthcheck: {
      test: [
        "CMD-SHELL",
        `node --eval="fetch('http://127.0.0.1:${STUDIO_CONTAINER_PORT}/api/platform/profile').then((r) => {if (!r.ok) throw new Error(r.status)})"`,
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    ports: [{ hostPort: String(input.port), containerPort: String(STUDIO_CONTAINER_PORT) }],
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: STUDIO_NETWORK_ALIASES,
    labels: {},
  };
}
