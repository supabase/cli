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
      workload("analytics", "analytics", "v1.50.6", "ghcr.io/supabase/cli/analytics:v1.50.6", {
        dependencies: ["database:database"],
        readiness: { mode: "http", portField: "api" },
      }),
      workload("vector", "analytics", "0.53.0-alpine", "ghcr.io/supabase/cli/vector:0.53.0", {
        dependencies: ["analytics:analytics"],
        readiness: { mode: "tcp" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: ["analytics.settings.api_key"],
  selectWorkloads: (settings, workloads) => {
    const value =
      typeof settings === "object" && settings !== null && !Array.isArray(settings)
        ? Object.fromEntries(Object.entries(settings)).vector_port
        : undefined;
    const enabled = typeof value === "number";
    return workloads.filter((entry) => enabled || entry.name !== "vector");
  },
  materialize: (settings) => settings,
};
