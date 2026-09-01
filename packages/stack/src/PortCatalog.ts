import { Schema } from "effect";
import type { ServiceName } from "./ServiceName.ts";
import type { StackMode } from "./StackConfig.ts";

export interface AllocatedPorts {
  readonly apiPort: number;
  readonly dbPort: number;
  readonly authPort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
  readonly edgeRuntimePort: number;
  readonly edgeRuntimeInspectorPort: number;
  readonly realtimePort: number;
  readonly storagePort: number;
  readonly imgproxyPort: number;
  readonly mailpitPort: number;
  readonly mailpitSmtpPort: number;
  readonly mailpitPop3Port: number;
  readonly pgmetaPort: number;
  readonly studioPort: number;
  readonly analyticsPort: number;
  /** Native Vector's private administration/health listener. Docker keeps this internal. */
  readonly vectorAdminPort: number;
  readonly poolerSessionPort: number;
  readonly poolerTransactionPort: number;
  readonly poolerApiPort: number;
  /** Native Supavisor's private session/transaction shard listener span. */
  readonly poolerInternalPort: number;
}

/** A selected allocation may contain any subset of the catalog fields. */
export type PortSet = Readonly<Partial<AllocatedPorts>>;

/** Every runnable or persisted stack has the two core listeners. */
export type ResolvedPorts = Readonly<PortSet & Pick<AllocatedPorts, "apiPort" | "dbPort">>;

export type PortField = keyof AllocatedPorts;

export type ConfigPortKey =
  | "api.port"
  | "db.port"
  | "edge_runtime.inspector_port"
  | "local_smtp.port"
  | "local_smtp.smtp_port"
  | "local_smtp.pop3_port"
  | "studio.port"
  | "analytics.port"
  | "db.pooler.session_port"
  | "db.pooler.transaction_port"
  | "db.pooler.api_port";

export interface PortCatalogEntry {
  readonly field: PortField;
  readonly configKey?: ConfigPortKey;
  readonly preferred?: number;
  readonly service?: ServiceName;
  /** The field is leased only by native runtime processes. */
  readonly nativeOnly?: boolean;
  /** Number of contiguous TCP ports owned by this field, including its base port (or by mode). */
  readonly span?: number | Readonly<Record<StackMode, number>>;
  readonly persistence: "runtime" | "sticky";
}

const PORT_CATALOG_ENTRIES: {
  readonly [Field in PortField]: PortCatalogEntry & { readonly field: Field };
} = {
  apiPort: { field: "apiPort", configKey: "api.port", preferred: 54321, persistence: "sticky" },
  dbPort: {
    field: "dbPort",
    configKey: "db.port",
    preferred: 54322,
    service: "postgres",
    persistence: "sticky",
  },
  authPort: { field: "authPort", service: "auth", persistence: "runtime" },
  postgrestPort: { field: "postgrestPort", service: "postgrest", persistence: "runtime" },
  postgrestAdminPort: {
    field: "postgrestAdminPort",
    service: "postgrest",
    persistence: "runtime",
  },
  edgeRuntimePort: {
    field: "edgeRuntimePort",
    preferred: 54341,
    service: "edge-runtime",
    persistence: "runtime",
  },
  edgeRuntimeInspectorPort: {
    field: "edgeRuntimeInspectorPort",
    configKey: "edge_runtime.inspector_port",
    preferred: 54342,
    service: "edge-runtime",
    persistence: "sticky",
  },
  // Realtime uses base for public HTTP, base + 1 for server gen_rpc,
  // base + 2 for seed HTTP, and base + 3 for seed gen_rpc in native mode.
  realtimePort: {
    field: "realtimePort",
    service: "realtime",
    span: { native: 4, docker: 1 },
    persistence: "runtime",
  },
  storagePort: { field: "storagePort", service: "storage", persistence: "runtime" },
  imgproxyPort: { field: "imgproxyPort", service: "imgproxy", persistence: "runtime" },
  mailpitPort: {
    field: "mailpitPort",
    configKey: "local_smtp.port",
    preferred: 54324,
    service: "mailpit",
    persistence: "sticky",
  },
  mailpitSmtpPort: {
    field: "mailpitSmtpPort",
    configKey: "local_smtp.smtp_port",
    preferred: 54325,
    service: "mailpit",
    persistence: "sticky",
  },
  mailpitPop3Port: {
    field: "mailpitPop3Port",
    configKey: "local_smtp.pop3_port",
    preferred: 54326,
    service: "mailpit",
    persistence: "sticky",
  },
  // postgres-meta binds its administrative listener at PG_META_PORT + 1.
  pgmetaPort: {
    field: "pgmetaPort",
    service: "pgmeta",
    span: { native: 2, docker: 1 },
    persistence: "runtime",
  },
  studioPort: {
    field: "studioPort",
    configKey: "studio.port",
    preferred: 54323,
    service: "studio",
    persistence: "sticky",
  },
  analyticsPort: {
    field: "analyticsPort",
    configKey: "analytics.port",
    preferred: 54327,
    service: "analytics",
    persistence: "sticky",
  },
  vectorAdminPort: {
    field: "vectorAdminPort",
    service: "vector",
    nativeOnly: true,
    persistence: "runtime",
  },
  poolerSessionPort: {
    field: "poolerSessionPort",
    configKey: "db.pooler.session_port",
    preferred: 54329,
    service: "pooler",
    persistence: "sticky",
  },
  poolerTransactionPort: {
    field: "poolerTransactionPort",
    configKey: "db.pooler.transaction_port",
    preferred: 54330,
    service: "pooler",
    persistence: "sticky",
  },
  poolerApiPort: {
    field: "poolerApiPort",
    configKey: "db.pooler.api_port",
    preferred: 54331,
    service: "pooler",
    persistence: "sticky",
  },
  poolerInternalPort: {
    field: "poolerInternalPort",
    service: "pooler",
    nativeOnly: true,
    span: 8,
    persistence: "runtime",
  },
};

export const PORT_CATALOG = PORT_CATALOG_ENTRIES;
export const PORT_FIELDS = [
  "apiPort",
  "dbPort",
  "authPort",
  "postgrestPort",
  "postgrestAdminPort",
  "edgeRuntimePort",
  "edgeRuntimeInspectorPort",
  "realtimePort",
  "storagePort",
  "imgproxyPort",
  "mailpitPort",
  "mailpitSmtpPort",
  "mailpitPop3Port",
  "pgmetaPort",
  "studioPort",
  "analyticsPort",
  "vectorAdminPort",
  "poolerSessionPort",
  "poolerTransactionPort",
  "poolerApiPort",
  "poolerInternalPort",
] as const satisfies ReadonlyArray<PortField>;
export const stickyPortFields: ReadonlyArray<PortField> = PORT_FIELDS.filter(
  (field) => PORT_CATALOG[field].persistence === "sticky",
);
export const runtimeOnlyPortFields: ReadonlyArray<PortField> = PORT_FIELDS.filter(
  (field) => PORT_CATALOG[field].persistence === "runtime",
);

const preferredPort = (field: PortField): number => {
  const preferred = PORT_CATALOG[field].preferred;
  if (preferred === undefined) {
    throw new Error(`Port catalog field ${field} has no preferred port`);
  }
  return preferred;
};

export const DEFAULT_API_PORT = preferredPort("apiPort");
export const DEFAULT_DB_PORT = preferredPort("dbPort");
export const DEFAULT_PORTS: PortSet = {
  apiPort: preferredPort("apiPort"),
  dbPort: preferredPort("dbPort"),
  edgeRuntimePort: preferredPort("edgeRuntimePort"),
  edgeRuntimeInspectorPort: preferredPort("edgeRuntimeInspectorPort"),
  mailpitPort: preferredPort("mailpitPort"),
  mailpitSmtpPort: preferredPort("mailpitSmtpPort"),
  mailpitPop3Port: preferredPort("mailpitPop3Port"),
  studioPort: preferredPort("studioPort"),
  analyticsPort: preferredPort("analyticsPort"),
  poolerSessionPort: preferredPort("poolerSessionPort"),
  poolerTransactionPort: preferredPort("poolerTransactionPort"),
  poolerApiPort: preferredPort("poolerApiPort"),
};

export const AllocatedPortsSchema = Schema.Struct({
  apiPort: Schema.Finite,
  dbPort: Schema.Finite,
  authPort: Schema.Finite,
  postgrestPort: Schema.Finite,
  postgrestAdminPort: Schema.Finite,
  edgeRuntimePort: Schema.Finite,
  edgeRuntimeInspectorPort: Schema.Finite,
  realtimePort: Schema.Finite,
  storagePort: Schema.Finite,
  imgproxyPort: Schema.Finite,
  mailpitPort: Schema.Finite,
  mailpitSmtpPort: Schema.Finite,
  mailpitPop3Port: Schema.Finite,
  pgmetaPort: Schema.Finite,
  studioPort: Schema.Finite,
  analyticsPort: Schema.Finite,
  vectorAdminPort: Schema.Finite,
  poolerSessionPort: Schema.Finite,
  poolerTransactionPort: Schema.Finite,
  poolerApiPort: Schema.Finite,
  poolerInternalPort: Schema.Finite,
});

export const PortSetSchema = Schema.Struct({
  apiPort: Schema.optionalKey(Schema.Finite),
  dbPort: Schema.optionalKey(Schema.Finite),
  authPort: Schema.optionalKey(Schema.Finite),
  postgrestPort: Schema.optionalKey(Schema.Finite),
  postgrestAdminPort: Schema.optionalKey(Schema.Finite),
  edgeRuntimePort: Schema.optionalKey(Schema.Finite),
  edgeRuntimeInspectorPort: Schema.optionalKey(Schema.Finite),
  realtimePort: Schema.optionalKey(Schema.Finite),
  storagePort: Schema.optionalKey(Schema.Finite),
  imgproxyPort: Schema.optionalKey(Schema.Finite),
  mailpitPort: Schema.optionalKey(Schema.Finite),
  mailpitSmtpPort: Schema.optionalKey(Schema.Finite),
  mailpitPop3Port: Schema.optionalKey(Schema.Finite),
  pgmetaPort: Schema.optionalKey(Schema.Finite),
  studioPort: Schema.optionalKey(Schema.Finite),
  analyticsPort: Schema.optionalKey(Schema.Finite),
  vectorAdminPort: Schema.optionalKey(Schema.Finite),
  poolerSessionPort: Schema.optionalKey(Schema.Finite),
  poolerTransactionPort: Schema.optionalKey(Schema.Finite),
  poolerApiPort: Schema.optionalKey(Schema.Finite),
  poolerInternalPort: Schema.optionalKey(Schema.Finite),
});

export const ResolvedPortsSchema = Schema.Struct({
  ...PortSetSchema.fields,
  apiPort: Schema.Finite,
  dbPort: Schema.Finite,
});
