import { Schema } from "effect";
import type { AuthRuntimeConfig, ResolvedAuthRuntimeConfig } from "./AuthConfig.ts";
import type { FunctionsConfig, ResolvedFunctionsConfig } from "./functions.ts";
import type { LocalCredentials, ResolvedLocalCredentials } from "./LocalCredentials.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";

type StackMode = "native" | "auto" | "docker";
type StackStartupMode = "eager" | "lazy";

export type ReadinessPolicy =
  | { readonly mode: "finite"; readonly timeoutMs: number }
  | { readonly mode: "infinite" };

export type ReadyOptions = { readonly mode: "inherit" } | ReadinessPolicy;

const ReadinessPolicySchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("finite"),
    timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ mode: Schema.Literal("infinite") }),
]);

/** The single wire representation accepted by Effect, Promise, and daemon Adapters. */
export const ReadyOptionsSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("inherit") }),
  ReadinessPolicySchema,
]);

export const inheritReadyOptions: ReadyOptions = { mode: "inherit" };

/** Standalone stacks wait at most two minutes unless a caller or launch Adapter chooses otherwise. */
export const DEFAULT_STACK_READINESS_POLICY: ReadinessPolicy = {
  mode: "finite",
  timeoutMs: 120_000,
};

/** Resolve readiness with per-call policy taking precedence over stack policy and package default. */
export const resolveReadinessPolicy = (input: {
  readonly readyOptions?: ReadyOptions;
  readonly stackPolicy?: ReadinessPolicy;
}): ReadinessPolicy =>
  input.readyOptions === undefined || input.readyOptions.mode === "inherit"
    ? (input.stackPolicy ?? DEFAULT_STACK_READINESS_POLICY)
    : input.readyOptions;

export interface PostgresConfig {
  readonly port?: number;
  readonly dataDir?: string;
  readonly version?: string;
  /**
   * Startup-health scheduling budget. Factories translate this duration into
   * their probe cadence without changing the post-healthy liveness threshold.
   * A zero value permits one immediate startup probe. A failing probe may
   * finish after the budget because its own execution timeout is independent.
   */
  readonly startupHealthTimeoutMs?: number;
  /**
   * When true (default), the bundled initial schema GRANTs that expose new tables, views,
   * sequences, and functions in `public` to the Data API roles (`anon`, `authenticated`,
   * `service_role`) are kept in place. When false, those default privileges are revoked so the
   * local stack matches the new cloud default and requires explicit GRANTs to surface entities
   * through the Data API.
   */
  readonly autoExposeNewTables?: boolean;
}

export interface PostgrestConfig {
  readonly schemas?: ReadonlyArray<string>;
  readonly extraSearchPath?: ReadonlyArray<string>;
  readonly maxRows?: number;
  readonly version?: string;
}

export type AuthConfig = AuthRuntimeConfig;

export interface RealtimeConfig {
  readonly port?: number;
  readonly version?: string;
  readonly tenantId?: string;
  readonly encryptionKey?: string;
  readonly secretKeyBase?: string;
  readonly maxHeaderLength?: number;
}

export interface EdgeRuntimeConfig {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly inspectorPort?: number;
  readonly policy?: "oneshot" | "per_worker";
  readonly version?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StorageConfig {
  readonly port?: number;
  readonly dataDir?: string;
  readonly fileSizeLimit?: string;
  readonly s3ProtocolEnabled?: boolean;
  readonly version?: string;
}

export interface ImgproxyConfig {
  readonly port?: number;
  readonly version?: string;
}

export interface MailpitConfig {
  readonly port?: number;
  /** Host port to publish for SMTP clients, or false to keep SMTP stack-internal. */
  readonly smtpPort?: number | false;
  /** Host port to publish for POP3 clients, or false to keep POP3 stack-internal. */
  readonly pop3Port?: number | false;
  readonly version?: string;
  readonly adminEmail?: string;
  readonly senderName?: string;
}

export interface PgmetaConfig {
  readonly port?: number;
  readonly version?: string;
}

export interface StudioConfig {
  readonly port?: number;
  readonly apiUrl?: string;
  readonly version?: string;
}

export interface AnalyticsConfig {
  readonly port?: number;
  readonly version?: string;
  readonly backend?: "postgres" | "bigquery";
  readonly apiKey?: string;
}

export interface VectorConfig {
  readonly version?: string;
}

export interface PoolerConfig {
  readonly port?: number;
  readonly apiPort?: number;
  readonly mode?: "transaction" | "session";
  readonly version?: string;
  readonly tenantId?: string;
  readonly encryptionKey?: string;
  readonly secretKeyBase?: string;
  readonly defaultPoolSize?: number;
  readonly maxClientConn?: number;
}

export interface StackConfig {
  readonly cacheRoot?: string;
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly projectDir?: string;
  readonly mode?: StackMode;
  /** Start all services immediately, or defer proxied services until first use. */
  readonly startupMode?: StackStartupMode;
  /** Stack-wide readiness policy. Per-call ReadyOptions take precedence. */
  readonly readiness?: ReadinessPolicy;
  readonly credentials?: LocalCredentials;
  /** @deprecated Prefer the explicit `credentials.signing` domain model. */
  readonly jwtSecret?: string;
  readonly port?: number;
  readonly publishableKey?: string;
  readonly secretKey?: string;
  readonly functions?: FunctionsConfig | false;
  readonly postgres?: PostgresConfig;
  readonly postgrest?: PostgrestConfig | false;
  readonly auth?: AuthConfig | false;
  readonly edgeRuntime?: EdgeRuntimeConfig | false;
  readonly realtime?: RealtimeConfig | false;
  readonly storage?: StorageConfig | false;
  readonly imgproxy?: ImgproxyConfig | false;
  readonly mailpit?: MailpitConfig | false;
  readonly pgmeta?: PgmetaConfig | false;
  readonly studio?: StudioConfig | false;
  readonly analytics?: AnalyticsConfig | false;
  readonly vector?: VectorConfig | false;
  readonly pooler?: PoolerConfig | false;
}

export interface ResolvedPostgresConfig {
  readonly port: number;
  readonly dataDir: string;
  readonly version: string;
  readonly startupHealthTimeoutMs?: number;
  readonly autoExposeNewTables: boolean;
}

export interface ResolvedPostgrestConfig {
  readonly port: number;
  readonly adminPort: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly version: string;
}

export type ResolvedAuthConfig = ResolvedAuthRuntimeConfig;

export interface ResolvedRealtimeConfig {
  readonly port: number;
  readonly version: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly maxHeaderLength: number;
}

export interface ResolvedEdgeRuntimeConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly inspectorPort: number;
  readonly policy: "oneshot" | "per_worker";
  readonly version: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ResolvedStorageConfig {
  readonly port: number;
  readonly version: string;
  readonly dataDir: string;
  readonly fileSizeLimit: string;
  readonly s3ProtocolEnabled: boolean;
}

export interface ResolvedImgproxyConfig {
  readonly port: number;
  readonly version: string;
}

export interface ResolvedMailpitConfig {
  readonly port: number;
  /** Private loopback bridge used by native or Docker Auth to reach Mailpit. */
  readonly smtpTransportPort: number;
  /** Optional user-facing host publications. */
  readonly smtpHostPort: number | false;
  readonly pop3HostPort: number | false;
  readonly version: string;
  readonly adminEmail: string;
  readonly senderName: string;
}

export interface ResolvedPgmetaConfig {
  readonly port: number;
  readonly version: string;
}

export interface ResolvedStudioConfig {
  readonly port: number;
  readonly version: string;
  readonly apiUrl: string;
}

export interface ResolvedAnalyticsConfig {
  readonly port: number;
  readonly version: string;
  readonly backend: "postgres" | "bigquery";
  readonly apiKey: string;
}

export interface ResolvedVectorConfig {
  readonly version: string;
}

export interface ResolvedPoolerConfig {
  readonly port: number;
  readonly apiPort: number;
  readonly mode: "transaction" | "session";
  readonly version: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly defaultPoolSize: number;
  readonly maxClientConn: number;
}

export interface ResolvedStackConfig {
  readonly cacheRoot: string;
  readonly stackRoot: string;
  readonly runtimeRoot: string;
  readonly projectDir: string;
  readonly mode: StackMode;
  readonly startupMode: StackStartupMode;
  readonly readiness: ReadinessPolicy;
  readonly credentials: ResolvedLocalCredentials;
  readonly jwtSecret: string;
  readonly ports: AllocatedPorts;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly functions: ResolvedFunctionsConfig | false;
  readonly autoManagedPaths: ReadonlyArray<string>;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly postgres: ResolvedPostgresConfig;
  readonly postgrest: ResolvedPostgrestConfig | false;
  readonly auth: ResolvedAuthConfig | false;
  readonly edgeRuntime: ResolvedEdgeRuntimeConfig | false;
  readonly realtime: ResolvedRealtimeConfig | false;
  readonly storage: ResolvedStorageConfig | false;
  readonly imgproxy: ResolvedImgproxyConfig | false;
  readonly mailpit: ResolvedMailpitConfig | false;
  readonly pgmeta: ResolvedPgmetaConfig | false;
  readonly studio: ResolvedStudioConfig | false;
  readonly analytics: ResolvedAnalyticsConfig | false;
  readonly vector: ResolvedVectorConfig | false;
  readonly pooler: ResolvedPoolerConfig | false;
}

export interface ResolvedDaemonConfig extends ResolvedStackConfig {
  readonly name: string;
  readonly projectDir: string;
}
