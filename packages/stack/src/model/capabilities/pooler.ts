import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { catalogEntryFor } from "../WorkloadCatalog.ts";

const version = catalogEntryFor("pooler:pooler").defaultVersion;

const Secret = Schema.Redacted(Schema.String);
export const PoolerSettingsSchema = Schema.Struct({
  pool_mode: Schema.optionalKey(Schema.Literals(["transaction", "session"] as const)),
  tenant_id: Schema.optionalKey(Schema.String),
  encryption_key: Schema.optionalKey(Secret),
  secret_key_base: Schema.optionalKey(Secret),
  default_pool_size: Schema.optionalKey(Schema.Finite),
  max_client_conn: Schema.optionalKey(Schema.Finite),
});
export type PoolerSettings = Schema.Schema.Type<typeof PoolerSettingsSchema>;
export const PoolerModule: CapabilityModule<PoolerSettings> = {
  name: "pooler",
  settings: PoolerSettingsSchema,
  defaultSettings: {
    pool_mode: "transaction",
    tenant_id: "pooler-dev",
    encryption_key: undefined,
    secret_key_base: undefined,
    default_pool_size: 20,
    max_client_conn: 100,
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: version,
  dependencies: ["database"],
  releases: {
    [version]: release(version, [
      workload("pooler", "pooler", {
        dependencies: ["database:database"],
        readiness: { portField: "pooler" },
      }),
    ]),
  },
  routes: [{ listener: "pooler", protocol: "tcp" }],
  secretPolicy: (path) =>
    path === "pooler.settings.encryption_key" || path === "pooler.settings.secret_key_base"
      ? "managed"
      : "passthrough",
  managedSecretSlots: ["pooler.settings.encryption_key", "pooler.settings.secret_key_base"],
};
