import { Schema } from "effect";
import type { ResolvedFunctionsBundle } from "./functions.ts";
import type { ResolvedPorts } from "./PortCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

import type { StackRuntimeSelection } from "./ContainerRuntime.ts";

export type StackMode = "native" | "docker";
export type ServicePolicy = "off" | "lazy" | "eager";
export type ServicePolicyManifest = Readonly<Record<ServiceName, ServicePolicy>>;

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

/**
 * What a Docker container name segment tolerates: this is used in the
 * namespaced `supabase-<service>-id-<instanceId>` form, so anything Docker
 * itself rejects there (path separators, colons, whitespace, …) must be
 * rejected here first. A managed caller's stack UUID always matches; a
 * hand-supplied `instanceId` must be shaped the same way.
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Validates {@link StackConfig.instanceId} against {@link INSTANCE_ID_PATTERN}. */
export const InstanceIdSchema = Schema.String.check(Schema.isPattern(INSTANCE_ID_PATTERN));

/** Default readiness deadline; lazy activation expands it for longer transitive startup budgets. */
export const DEFAULT_STACK_READINESS_POLICY: ReadinessPolicy = {
  mode: "finite",
  timeoutMs: 180_000,
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
   * When true (default), the bundled initial schema GRANTs that expose new tables, views,
   * sequences, and functions in `public` to the Data API roles (`anon`, `authenticated`,
   * `service_role`) are kept in place, matching the cloud default. When false, those default
   * privileges are revoked so new entities require explicit GRANTs to surface through the Data
   * API, matching a cloud project with the "Default privileges for new entities" toggle turned
   * off.
   */
  readonly autoExposeNewTables?: boolean;
}

export interface PostgrestConfig {
  readonly schemas?: ReadonlyArray<string>;
  readonly extraSearchPath?: ReadonlyArray<string>;
  readonly maxRows?: number;
  readonly version?: string;
}

export interface AuthConfig {
  readonly port?: number;
  readonly siteUrl?: string;
  readonly jwtExpiry?: number;
  readonly externalUrl?: string;
  readonly version?: string;
}

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
  readonly smtpPort?: number;
  readonly pop3Port?: number;
  readonly dataDir?: string;
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
  readonly sessionPort?: number;
  readonly transactionPort?: number;
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
  /**
   * An opaque identity for this stack, namespaced in the names and preserved
   * verbatim in the labels of the Docker resources it owns so two stacks never
   * collide on them — which is exactly why it must itself be a Docker-name-safe
   * token: see {@link INSTANCE_ID_PATTERN}.
   *
   * The runtime never interprets its structure beyond that — a managed caller
   * passes its stack id (a UUID, which already matches), and a caller that
   * passes nothing keeps the port-derived names it always had.
   */
  readonly instanceId?: string;
  readonly cacheRoot?: string;
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly projectDir?: string;
  readonly mode?: StackMode;
  /** Per-service resource policy. `off` excludes a service from the graph. */
  readonly servicePolicies?: Partial<Record<ServiceName, ServicePolicy>>;
  /** Stack-wide readiness policy. Per-call ReadyOptions take precedence. */
  readonly readiness?: ReadinessPolicy;
  readonly jwtSecret?: string;
  readonly port?: number;
  readonly publishableKey?: string;
  readonly secretKey?: string;
  readonly functions?: ResolvedFunctionsBundle | false;
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

export interface ResolvedAuthConfig {
  readonly port: number;
  readonly siteUrl: string;
  readonly jwtExpiry: number;
  readonly externalUrl: string;
  readonly version: string;
}

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
  readonly smtpPort: number;
  readonly pop3Port: number;
  readonly dataDir: string;
  /** Whether the data directory came from the package-managed stack root. */
  readonly dataDirIsAutoManaged: boolean;
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
  /** Native Vector's private administration/health listener; absent for Docker. */
  readonly adminPort?: number;
}

export interface ResolvedPoolerConfig {
  readonly sessionPort: number;
  readonly transactionPort: number;
  readonly apiPort: number;
  /** Base port for native Supavisor's private session/transaction shard listeners. */
  readonly internalPort?: number;
  readonly mode: "transaction" | "session";
  readonly version: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly defaultPoolSize: number;
  readonly maxClientConn: number;
}

export interface ResolvedStackConfig {
  /** The opaque identity this stack's Docker resources are keyed by, if any. */
  readonly instanceId?: string;
  readonly cacheRoot: string;
  readonly stackRoot: string;
  readonly runtimeRoot: string;
  readonly projectDir: string;
  /** Concrete execution mode and, for containers, the selected executable. */
  readonly runtime: StackRuntimeSelection;
  readonly servicePolicies: ServicePolicyManifest;
  readonly readiness: ReadinessPolicy;
  /** Whether readiness came from the package default or an explicit stack policy. */
  readonly readinessSource: "default" | "configured";
  readonly jwtSecret: string;
  readonly ports: ResolvedPorts;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly functions: ResolvedFunctionsBundle | false;
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
