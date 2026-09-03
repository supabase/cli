import { Schema } from "effect";

export const RuntimeEngineSchema = Schema.Literals(["docker", "podman"] as const);
export type RuntimeEngine = Schema.Schema.Type<typeof RuntimeEngineSchema>;

export const StackRuntimeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("native") }),
  Schema.Struct({ kind: Schema.Literal("container"), engine: RuntimeEngineSchema }),
]);
export type StackRuntime = Schema.Schema.Type<typeof StackRuntimeSchema>;

export const StackRuntimePreferenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("native") }),
  Schema.Struct({
    kind: Schema.Literal("container"),
    engine: Schema.optionalKey(RuntimeEngineSchema),
  }),
]);
export type StackRuntimePreference = Schema.Schema.Type<typeof StackRuntimePreferenceSchema>;
