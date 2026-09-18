/**
 * Studio env + container spec builder. Gating, image resolution, and edge-function bind-mount
 * resolution are the caller's responsibility.
 *
 * The host snippets path (`<workdir>/supabase/snippets`) is a plain top-level directory, not
 * under `supabase/.temp/` (reserved for the link-state cache) — snippets are persistent user
 * content Studio's SQL Editor reads/writes, not a cache. {@link buildStudioContainerSpec} computes
 * its in-container mount form once and reuses it for both the bind mount and
 * {@link buildStudioEnv}'s `SNIPPETS_MANAGEMENT_FOLDER`.
 */

import { join } from "node:path";

import { toDockerMountPath } from "../../../command-internal/docker-path.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";

/** Container-internal port Studio listens on — hardcoded, never configurable. */
const STUDIO_CONTAINER_PORT = 3000;

/** The Studio network alias — a fixed, non-configurable constant. */
const STUDIO_NETWORK_ALIASES = ["studio"];

/** The analytics API key; never decoded from `config.toml` or overridable, so it's always this value. */
const LOGFLARE_PRIVATE_ACCESS_TOKEN = "api-key";

export interface BuildStudioEnvInput {
  /** The db password — becomes `POSTGRES_PASSWORD`. */
  readonly dbPassword: string;
  /** The already-resolved absolute project root; `EDGE_FUNCTIONS_MANAGEMENT_FOLDER` is resolved against it (`<workdir>/supabase/functions`). */
  readonly workdir: string;
  /** Becomes `SNIPPETS_MANAGEMENT_FOLDER` verbatim; see this module's header for how it's derived. */
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
   * Becomes `SUPABASE_PUBLIC_URL`. Not the raw `config.studio.api_url` field: under a default
   * config its host (`127.0.0.1`) is rewritten to the Kong URL before `start` reads it, and the
   * caller must apply that rewrite before passing this field in.
   */
  readonly studioApiUrl: string;
  /** `resolveLocalConfigValues(...).jwtSecret` — `AUTH_JWT_SECRET`. */
  readonly jwtSecret: string;
  /** `resolveLocalConfigValues(...).anonKey` — `SUPABASE_ANON_KEY`. */
  readonly anonKey: string;
  /** `resolveLocalConfigValues(...).serviceRoleKey` — `SUPABASE_SERVICE_KEY`. */
  readonly serviceRoleKey: string;
  /** `resolveLocalConfigValues(...).publishableKey` — `SUPABASE_PUBLISHABLE_KEY`. */
  readonly publishableKey: string;
  /** `resolveLocalConfigValues(...).secretKey` — `SUPABASE_SECRET_KEY`. */
  readonly secretKey: string;
  /** `resolveLocalConfigValues(...).storageS3AccessKeyId` — `S3_PROTOCOL_ACCESS_KEY_ID`. */
  readonly s3AccessKeyId: string;
  /** `resolveLocalConfigValues(...).storageS3SecretAccessKey` — `S3_PROTOCOL_ACCESS_KEY_SECRET`. */
  readonly s3SecretAccessKey: string;
  /** `config.studio.openai_api_key`, resolved by the caller; `undefined` maps to `""` (unset). */
  readonly openaiApiKey: string | undefined;
  /** `config.api.schemas` — `PGRST_DB_SCHEMAS`, comma-joined. */
  readonly apiSchemas: ReadonlyArray<string>;
  /** `config.api.extra_search_path` — `PGRST_DB_EXTRA_SEARCH_PATH`, comma-joined. */
  readonly apiExtraSearchPath: ReadonlyArray<string>;
  /** `config.api.max_rows` — `PGRST_DB_MAX_ROWS`. */
  readonly apiMaxRows: number;
  /** `envOverrideBool`-resolved `analytics.enabled` — `NEXT_PUBLIC_ENABLE_LOGS`. */
  readonly analyticsEnabled: boolean;
  /** `config.analytics.backend`, post-`SUPABASE_ANALYTICS_BACKEND`-override — `NEXT_ANALYTICS_BACKEND_PROVIDER`. */
  readonly analyticsBackend: "postgres" | "bigquery";
}

/**
 * Builds Studio's container env as a `KEY -> value` map, matching {@link StartContainerSpec.env}'s
 * shape, so secret values never round-trip through this process's own `docker create` argv.
 */
export function buildStudioEnv(input: BuildStudioEnvInput): Record<string, string> {
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
    EDGE_FUNCTIONS_MANAGEMENT_FOLDER: toDockerMountPath(
      join(input.workdir, "supabase", "functions"),
    ),
    SNIPPETS_MANAGEMENT_FOLDER: input.containerSnippetsPath,
    // Ref: https://github.com/vercel/next.js/issues/51684#issuecomment-1612834913
    HOSTNAME: "0.0.0.0",
    POSTGRES_USER_READ_WRITE: "postgres",
  };
}

export interface StudioContainerInput {
  /** `config.studio.image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `serviceContainerName("studio", projectId)`. */
  readonly containerName: string;
  /** The shared Docker network every `start` container joins. */
  readonly networkId: string;
  /** `config.studio.port` — the host port published to `3000/tcp`. */
  readonly port: number;
  /**
   * Per-enabled-Edge-Function module bind mounts, resolved from each `supabase/functions/<slug>`'s
   * deploy config. Pass `[]` until an edge-functions-serve integration supplies these.
   */
  readonly functionBinds: ReadonlyArray<string>;
  /** Every value {@link buildStudioEnv} needs, minus the path this builder derives itself. */
  readonly env: Omit<BuildStudioEnvInput, "containerSnippetsPath">;
}

/** Builds Studio's {@link StartContainerSpec}, including the snippets bind mount. */
export function buildStudioContainerSpec(input: StudioContainerInput): StartContainerSpec {
  const hostSnippetsPath = join(input.env.workdir, "supabase", "snippets");
  const containerSnippetsPath = toDockerMountPath(hostSnippetsPath);

  // Order-preserving dedup; `Set` iteration order is first-seen-wins.
  const binds = Array.from(
    new Set([...input.functionBinds, `${hostSnippetsPath}:${containerSnippetsPath}:rw`]),
  );

  return {
    image: input.image,
    containerName: input.containerName,
    env: buildStudioEnv({ ...input.env, containerSnippetsPath }),
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
