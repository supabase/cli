import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { NetworkPortSchema } from "../../public/Status.ts";

const Secret = Schema.Redacted(Schema.String);
const FunctionSlug = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
const EnvName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/));
const FunctionOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.String),
  entrypoint: Schema.optionalKey(Schema.String),
  static_files: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(EnvName, Secret)),
});
export const FunctionsSettingsSchema = Schema.Struct({
  functions_root: Schema.optionalKey(Schema.String),
  edge_runtime: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      policy: Schema.optionalKey(Schema.Literals(["oneshot", "per_worker"] as const)),
      inspector_port: Schema.optionalKey(NetworkPortSchema),
      deno_version: Schema.optionalKey(Schema.Finite),
      secrets: Schema.optionalKey(Schema.Record(Schema.String, Secret)),
    }),
  ),
  functions: Schema.optionalKey(Schema.Record(FunctionSlug, FunctionOverride)),
});
export type FunctionsSettings = Schema.Schema.Type<typeof FunctionsSettingsSchema>;

const functionDefaults = {
  enabled: true,
  verify_jwt: true,
  import_map: "",
  entrypoint: "",
  static_files: [],
  env: {},
};

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
  defaultVersion: "v1.74.3",
  dependencies: ["database"],
  releases: {
    "v1.74.3": release("v1.74.3", [
      workload("edge-runtime", "functions", "v1.74.3", "supabase/edge-runtime:v1.74.3", {
        dependencies: ["database:database"],
        readiness: { mode: "http", portField: "functionsInspector" },
      }),
    ]),
  },
  routes: [
    { listener: "api", protocol: "http" },
    { listener: "functionsInspector", protocol: "http" },
  ],
  materialize: (settings) => ({
    ...settings,
    functions: Object.fromEntries(
      Object.entries(settings.functions ?? {}).map(([name, fn]) => [
        name,
        { ...functionDefaults, ...fn, env: fn.env ?? {} },
      ]),
    ),
  }),
};
