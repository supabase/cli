import { Schema } from "effect";
import { identityMaterialize, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Secret = Schema.Redacted(Schema.String);
export const PoolerSettingsSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["transaction", "session"] as const)),
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
    mode: "transaction",
    tenant_id: undefined,
    encryption_key: undefined,
    secret_key_base: undefined,
    default_pool_size: 20,
    max_client_conn: 100,
  },
  defaultEnabled: false,
  defaultActivation: "eager",
  dependencies: ["database"],
  workloads: [
    workload("pooler", "pooler", "2.9.7", "ghcr.io/supabase/supavisor:2.9.7", {
      dependencies: ["database:database"],
      readiness: { mode: "tcp", portField: "pooler" },
    }),
  ],
  routes: [{ listener: "pooler", protocol: "tcp" }],
  materialize: (settings) => identityMaterialize(settings),
  runtimeArtifact: (entry, runtime) =>
    runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
};
