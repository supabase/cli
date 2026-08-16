import { Schema } from "effect";
import type { ServiceName } from "./ServiceName.ts";

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
  readonly poolerPort: number;
  readonly poolerApiPort: number;
}

export type ResolvedPorts = Readonly<Partial<AllocatedPorts>>;

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
  | "db.pooler.port";

export interface PortCatalogEntry {
  readonly field: PortField;
  readonly configKey?: ConfigPortKey;
  readonly preferred?: number;
  readonly service?: ServiceName;
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
  realtimePort: { field: "realtimePort", service: "realtime", persistence: "runtime" },
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
  pgmetaPort: { field: "pgmetaPort", service: "pgmeta", persistence: "runtime" },
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
  poolerPort: {
    field: "poolerPort",
    configKey: "db.pooler.port",
    preferred: 54329,
    service: "pooler",
    persistence: "sticky",
  },
  poolerApiPort: { field: "poolerApiPort", service: "pooler", persistence: "runtime" },
};

export const PORT_CATALOG = PORT_CATALOG_ENTRIES;
export const PORT_FIELDS: ReadonlyArray<PortField> = Object.values(PORT_CATALOG).map(
  (entry) => entry.field,
);
const CONFIG_PORT_KEYS: ReadonlySet<string> = new Set(
  PORT_FIELDS.flatMap((field) => {
    const key = PORT_CATALOG[field].configKey;
    return key === undefined ? [] : [key];
  }),
);
export const isConfigPortKey = (value: string): value is ConfigPortKey =>
  CONFIG_PORT_KEYS.has(value);
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
export const DEFAULT_PORTS: Partial<AllocatedPorts> = {
  apiPort: preferredPort("apiPort"),
  dbPort: preferredPort("dbPort"),
  edgeRuntimePort: preferredPort("edgeRuntimePort"),
  edgeRuntimeInspectorPort: preferredPort("edgeRuntimeInspectorPort"),
  mailpitPort: preferredPort("mailpitPort"),
  mailpitSmtpPort: preferredPort("mailpitSmtpPort"),
  mailpitPop3Port: preferredPort("mailpitPop3Port"),
  studioPort: preferredPort("studioPort"),
  analyticsPort: preferredPort("analyticsPort"),
  poolerPort: preferredPort("poolerPort"),
};

export const AllocatedPortsSchema = Schema.Struct({
  apiPort: Schema.Number,
  dbPort: Schema.Number,
  authPort: Schema.Number,
  postgrestPort: Schema.Number,
  postgrestAdminPort: Schema.Number,
  edgeRuntimePort: Schema.Number,
  edgeRuntimeInspectorPort: Schema.Number,
  realtimePort: Schema.Number,
  storagePort: Schema.Number,
  imgproxyPort: Schema.Number,
  mailpitPort: Schema.Number,
  mailpitSmtpPort: Schema.Number,
  mailpitPop3Port: Schema.Number,
  pgmetaPort: Schema.Number,
  studioPort: Schema.Number,
  analyticsPort: Schema.Number,
  poolerPort: Schema.Number,
  poolerApiPort: Schema.Number,
});

export const ResolvedPortsSchema = Schema.Struct({
  apiPort: Schema.optionalKey(Schema.Number),
  dbPort: Schema.optionalKey(Schema.Number),
  authPort: Schema.optionalKey(Schema.Number),
  postgrestPort: Schema.optionalKey(Schema.Number),
  postgrestAdminPort: Schema.optionalKey(Schema.Number),
  edgeRuntimePort: Schema.optionalKey(Schema.Number),
  edgeRuntimeInspectorPort: Schema.optionalKey(Schema.Number),
  realtimePort: Schema.optionalKey(Schema.Number),
  storagePort: Schema.optionalKey(Schema.Number),
  imgproxyPort: Schema.optionalKey(Schema.Number),
  mailpitPort: Schema.optionalKey(Schema.Number),
  mailpitSmtpPort: Schema.optionalKey(Schema.Number),
  mailpitPop3Port: Schema.optionalKey(Schema.Number),
  pgmetaPort: Schema.optionalKey(Schema.Number),
  studioPort: Schema.optionalKey(Schema.Number),
  analyticsPort: Schema.optionalKey(Schema.Number),
  poolerPort: Schema.optionalKey(Schema.Number),
  poolerApiPort: Schema.optionalKey(Schema.Number),
});
