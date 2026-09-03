import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Secret = Schema.Redacted(Schema.String);
const FunctionSlug = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
const EnvName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/));
const FunctionOverrideSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.String),
  entrypoint: Schema.optionalKey(Schema.String),
  static_files: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(EnvName, Secret)),
});

const EdgeRuntimeSettingsSchema = Schema.Struct({
  policy: Schema.optionalKey(Schema.Literals(["oneshot", "per_worker"] as const)),
  deno_version: Schema.optionalKey(Schema.Finite),
  /** Defaults applied to functions discovered after the stack starts. */
  verify_jwt_default: Schema.optionalKey(Schema.Boolean),
  import_map_default: Schema.optionalKey(Schema.String),
  secrets: Schema.optionalKey(Schema.Record(Schema.String, Secret)),
});

export const FunctionsInspectorSettingsSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["run", "brk", "wait"] as const)),
  main: Schema.optionalKey(Schema.Boolean),
});
export type FunctionsInspectorSettings = Schema.Schema.Type<
  typeof FunctionsInspectorSettingsSchema
>;

export const FunctionsSettingsSchema = Schema.Struct({
  functions_root: Schema.optionalKey(Schema.String),
  /** Edge Runtime behavior; capability enabled and functionsInspector port are public fields. */
  edge_runtime: Schema.optionalKey(EdgeRuntimeSettingsSchema),
  inspector: Schema.optionalKey(FunctionsInspectorSettingsSchema),
  functions: Schema.optionalKey(Schema.Record(FunctionSlug, FunctionOverrideSchema)),
});
export type FunctionsSettings = Schema.Schema.Type<typeof FunctionsSettingsSchema>;

export const FunctionsModule: CapabilityModule<FunctionsSettings> = {
  name: "functions",
  settings: FunctionsSettingsSchema,
  defaultSettings: {
    functions_root: "supabase/functions",
    edge_runtime: {
      policy: "per_worker",
      deno_version: 2,
      secrets: {},
    },
    inspector: undefined,
    functions: {},
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: "v1.74.3",
  dependencies: ["database"],
  releases: {
    "v1.74.3": release("v1.74.3", [
      workload("edge-runtime", "functions", {
        dependencies: ["database:database"],
        readiness: { portField: "functionsInspector" },
      }),
    ]),
  },
  routes: [
    { listener: "api", protocol: "http" },
    { listener: "functionsInspector", protocol: "http" },
  ],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
  materialize: (settings) => ({
    ...settings,
    functions: Object.fromEntries(
      Object.entries(settings.functions ?? {}).map(([name, fn]) => [
        name,
        {
          enabled: fn.enabled ?? true,
          verify_jwt: fn.verify_jwt ?? true,
          import_map: fn.import_map ?? "",
          entrypoint: fn.entrypoint ?? "",
          static_files: fn.static_files ?? [],
          env: fn.env ?? {},
        },
      ]),
    ),
  }),
};
