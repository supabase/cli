import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { NetworkPortSchema } from "../../public/Status.ts";

const Secret = Schema.Redacted(Schema.String);
export const AnalyticsSettingsSchema = Schema.Struct({
  backend: Schema.optionalKey(Schema.Literals(["postgres", "bigquery"] as const)),
  vector_port: Schema.optionalKey(NetworkPortSchema),
  gcp_project_id: Schema.optionalKey(Schema.String),
  gcp_project_number: Schema.optionalKey(Schema.String),
  gcp_jwt_path: Schema.optionalKey(Schema.String),
  api_key: Schema.optionalKey(Secret),
});
export type AnalyticsSettings = Schema.Schema.Type<typeof AnalyticsSettingsSchema>;
export const AnalyticsModule: CapabilityModule<AnalyticsSettings> = {
  name: "analytics",
  settings: AnalyticsSettingsSchema,
  defaultSettings: {
    backend: "postgres",
    vector_port: undefined,
    gcp_project_id: undefined,
    gcp_project_number: undefined,
    gcp_jwt_path: undefined,
    api_key: undefined,
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: "v1.50.6",
  dependencies: ["database"],
  releases: {
    "v1.50.6": release("v1.50.6", [
      workload("analytics", "analytics", "v1.50.6", "supabase/logflare:v1.50.6", {
        dependencies: ["database:database", "analytics:vector"],
        readiness: { mode: "http", portField: "api" },
      }),
      workload("vector", "analytics", "0.53.0-alpine", "ghcr.io/supabase/vector:0.53.0-alpine", {
        dependencies: [],
        readiness: { mode: "tcp" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
  materialize: (settings) => settings,
};
