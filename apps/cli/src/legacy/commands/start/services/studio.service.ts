/**
 * Studio env + container spec builder, gated on `config.studio.enabled` and
 * `!isContainerExcluded(config.studio.image, excluded)` — see
 * `legacy-service-catalog.ts`'s `studio` entry (`excludeKey: "studio"`, gated
 * on `studio.enabled`, depends on pg-meta being healthy/running). Gating,
 * image resolution/pre-pull, and edge-function bind-mount resolution
 * (`serve.PopulatePerFunctionConfigs`, out of scope here — see
 * {@link LegacyStudioContainerInput.functionBinds}) are the caller's job (a
 * future `start.handler.ts`).
 *
 * `workdir`/`containerSnippetsPath`: the host snippets path is
 * `filepath.Join(workdir, "supabase", "snippets")` — a plain top-level
 * `<project>/supabase/snippets` directory, NOT under `supabase/.temp/` (that
 * directory is reserved for the link-state cache, see
 * `legacy-temp-paths.ts`; snippets are user content Studio's SQL Editor
 * reads/writes, meant to persist, not a cache). `containerSnippetsPath` is
 * that host path translated to its in-container mount form (see
 * {@link legacyToDockerPath}), computed once by
 * {@link legacyBuildStudioContainerSpec} and threaded into both the bind mount
 * and {@link legacyBuildStudioEnv}'s `SNIPPETS_MANAGEMENT_FOLDER`.
 */

import type { Path } from "effect";

import { legacyToDockerPath } from "../../../shared/legacy-docker-path.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";

/** Container-internal port Studio listens on — hardcoded, never configurable. */
const STUDIO_CONTAINER_PORT = 3000;

/** The Studio network alias — a fixed, non-configurable constant. */
const STUDIO_NETWORK_ALIASES = ["studio"];

/**
 * The default analytics API key — never decoded from `config.toml`, never
 * overridable — so this is always the value regardless of the resolved
 * project config, exactly like `legacy-local-config-values.ts`'s other
 * hardcoded, schema-absent constants (`DEFAULT_DB_PASSWORD`, the S3
 * credential triple).
 */
const LOGFLARE_PRIVATE_ACCESS_TOKEN = "api-key";

export interface LegacyBuildStudioEnvInput {
  /** Platform path service used for host path derivation. */
  readonly path: Path.Path;
  /** The db password — becomes `POSTGRES_PASSWORD`. */
  readonly dbPassword: string;
  /**
   * `LegacyCliConfig.workdir`, the already-resolved absolute project root —
   * `EDGE_FUNCTIONS_MANAGEMENT_FOLDER` is resolved against it
   * (`<workdir>/supabase/functions`).
   */
  readonly workdir: string;
  /**
   * Becomes `SNIPPETS_MANAGEMENT_FOLDER` verbatim. See this module's doc
   * comment for what it is and how it's derived.
   */
  readonly containerSnippetsPath: string;
  /** `CURRENT_CLI_VERSION`. */
  readonly cliVersion: string;
  /** pg-meta's own container name — `STUDIO_PG_META_URL=http://<name>:8080`. */
  readonly pgMetaContainerName: string;
  /** Kong's own container name — `SUPABASE_URL=http://<name>:8000`. */
  readonly kongContainerName: string;
  /** Logflare's own container name — `LOGFLARE_URL=http://<name>:4000`. */
  readonly logflareContainerName: string;
  /**
   * `config.studio.api_url`, post-`SUPABASE_STUDIO_API_URL`-override AND
   * post-config-validation's host-rewrite (`legacyResolveStudioApiUrl`) —
   * `SUPABASE_PUBLIC_URL`. Distinct from `LegacyLocalConfigValues.studioUrl`
   * (the `http://<hostname>:<port>` value `status` reports). This is NOT
   * simply the raw `studio.api_url` field: under a default config its host
   * (`127.0.0.1`) matches the local hostname, so it's rewritten to
   * `Config.Api.ExternalUrl` (the Kong URL) before `start` ever reads it —
   * the caller must apply that same rewrite before passing this field in.
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
   * `OPENAI_API_KEY`. `undefined` maps to `""`, the unset-secret case.
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
 * Builds Studio's container env. Returns a `KEY -> value` map —
 * {@link LegacyStartContainerSpec.env}'s own shape, chosen so secret values
 * never round-trip through this process's own `docker create` argv (see that
 * field's doc comment in `docker-create-args.ts`). Pure — no Effect or I/O —
 * so every env var mapping is unit-testable in isolation.
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
      input.path.join(input.workdir, "supabase", "functions"),
    ),
    SNIPPETS_MANAGEMENT_FOLDER: input.containerSnippetsPath,
    // Ref: https://github.com/vercel/next.js/issues/51684#issuecomment-1612834913
    HOSTNAME: "0.0.0.0",
    POSTGRES_USER_READ_WRITE: "postgres",
  };
}

export interface LegacyStudioContainerInput {
  /** Platform path service used for host path derivation. */
  readonly path: Path.Path;
  /** `config.studio.image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `legacyServiceContainerName("studio", projectId)`. */
  readonly containerName: string;
  /** The shared Docker network every `start` container joins. */
  readonly networkId: string;
  /** `config.studio.port` — the host port published to `3000/tcp`. */
  readonly port: number;
  /**
   * The per-enabled-Edge-Function module bind mounts resolved from each
   * `supabase/functions/<slug>`'s deploy config
   * (`serve.PopulatePerFunctionConfigs`). Out of scope for now (a separate,
   * large functions-deploy-config-parsing concern); pass `[]` until a
   * future edge-functions-serve integration supplies these.
   */
  readonly functionBinds: ReadonlyArray<string>;
  /** Every value {@link legacyBuildStudioEnv} needs, minus the path this builder derives itself. */
  readonly env: Omit<LegacyBuildStudioEnvInput, "containerSnippetsPath" | "path">;
}

/**
 * Assembles Studio's {@link LegacyStartContainerSpec}, including the snippets
 * bind mount and its Docker-path form, derived from `workdir` once and
 * reused for both the bind and {@link legacyBuildStudioEnv}'s
 * `SNIPPETS_MANAGEMENT_FOLDER`.
 */
export function legacyBuildStudioContainerSpec(
  input: LegacyStudioContainerInput,
): LegacyStartContainerSpec {
  const hostSnippetsPath = input.path.join(input.env.workdir, "supabase", "snippets");
  const containerSnippetsPath = legacyToDockerPath(hostSnippetsPath);

  // Order-preserving dedup; `Set` iteration order is first-seen-wins.
  const binds = Array.from(
    new Set([...input.functionBinds, `${hostSnippetsPath}:${containerSnippetsPath}:rw`]),
  );

  return {
    image: input.image,
    containerName: input.containerName,
    env: legacyBuildStudioEnv({ ...input.env, path: input.path, containerSnippetsPath }),
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
