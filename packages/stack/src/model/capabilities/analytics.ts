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
    gcp_project_id: "local",
    gcp_project_number: "0",
    gcp_jwt_path: undefined,
    api_key: undefined,
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: "v1.50.6",
  dependencies: ["database"],
  releases: {
    "v1.50.6": release("v1.50.6", [
      workload("analytics", "analytics", {
        dependencies: ["database:database"],
        readiness: { mode: "http", portField: "api" },
      }),
      workload("vector", "analytics", {
        dependencies: ["analytics:analytics"],
        readiness: { mode: "tcp" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: () => "managed",
  managedSecretSlots: ["analytics.settings.api_key"],
  selectWorkloads: (settings, workloads) => {
    const enabled = typeof settings.vector_port === "number";
    return workloads.filter((entry) => enabled || entry.name !== "vector");
  },
};
