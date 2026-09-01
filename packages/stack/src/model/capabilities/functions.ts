import { Redacted, Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Secret = Schema.Redacted(Schema.String);
export type FunctionSecret = Redacted.Redacted<string>;
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

/** Fully materialized per-function settings consumed by request-time discovery. */
export interface FunctionSettings {
  readonly enabled: boolean;
  readonly verify_jwt: boolean;
  readonly import_map: string;
  readonly entrypoint: string;
  readonly static_files: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, FunctionSecret>>;
}
export type MaterializedFunctionSettings = Readonly<Record<string, FunctionSettings>>;

export const FunctionSettingsDefaults: FunctionSettings = {
  enabled: true,
  verify_jwt: true,
  import_map: "",
  entrypoint: "",
  static_files: [],
  env: {},
};

const EdgeRuntimeSettingsSchema = Schema.Struct({
  policy: Schema.optionalKey(Schema.Literals(["oneshot", "per_worker"] as const)),
  deno_version: Schema.optionalKey(Schema.Finite),
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
        readiness: { mode: "http", portField: "functionsInspector" },
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
        { ...FunctionSettingsDefaults, ...fn, env: fn.env ?? {} },
      ]),
    ),
  }),
};
