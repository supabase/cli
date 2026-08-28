import { Schema } from "effect";
import { identityMaterialize, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Secret = Schema.Redacted(Schema.String);
const FunctionOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.String),
  entrypoint: Schema.optionalKey(Schema.String),
  static_files: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Secret)),
});
export const FunctionsSettingsSchema = Schema.Struct({
  functions_root: Schema.optionalKey(Schema.String),
  edge_runtime: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      policy: Schema.optionalKey(Schema.Literals(["oneshot", "per_worker"] as const)),
      inspector_port: Schema.optionalKey(Schema.Finite),
      deno_version: Schema.optionalKey(Schema.Finite),
      secrets: Schema.optionalKey(Schema.Record(Schema.String, Secret)),
    }),
  ),
  functions: Schema.optionalKey(Schema.Record(Schema.String, FunctionOverride)),
});
export type FunctionsSettings = Schema.Schema.Type<typeof FunctionsSettingsSchema>;

export const FunctionsModule: CapabilityModule<FunctionsSettings> = {
  name: "functions",
  settings: FunctionsSettingsSchema,
  defaultSettings: {
    functions_root: "supabase/functions",
    edge_runtime: {
      enabled: true,
      policy: "per_worker",
      inspector_port: 8083,
      deno_version: 2,
      secrets: {},
    },
    functions: {},
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  dependencies: ["database"],
  workloads: [
    workload("edge-runtime", "functions", "v1.74.3", "supabase/edge-runtime:v1.74.3", {
      dependencies: ["database:database"],
      readiness: { mode: "http", portField: "functionsInspector" },
    }),
  ],
  routes: [
    { listener: "api", protocol: "http" },
    { listener: "functionsInspector", protocol: "http" },
  ],
  materialize: (settings) => identityMaterialize(settings),
  runtimeArtifact: (entry, runtime) =>
    runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
};
