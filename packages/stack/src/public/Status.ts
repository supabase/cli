import { Effect, Schema, SchemaGetter } from "effect";
import { StackIdSchema, type StackId } from "./StackId.ts";
import {
  ActivationModeSchema,
  CAPABILITY_NAMES,
  CapabilityStatusSchema,
  type ActivationMode,
  type CapabilityName,
  type CapabilityStatus,
} from "./Capability.ts";
import { StackRuntimeSchema, type StackRuntime } from "./Runtime.ts";

export const StackLifecycleSchema = Schema.Literals([
  "unconfigured",
  "stopped",
  "starting",
  "running",
  "stopping",
  "destroying",
] as const);
export type StackLifecycle = Schema.Schema.Type<typeof StackLifecycleSchema>;

export const DesiredStackLifecycleSchema = Schema.Literals([
  "unconfigured",
  "stopped",
  "running",
  "destroying",
] as const);
export type DesiredStackLifecycle = Schema.Schema.Type<typeof DesiredStackLifecycleSchema>;

/** Listener keys are shared by the public status and closed config schemas. */
export const PORT_FIELDS = [
  "api",
  "database",
  "pooler",
  "studio",
  "mailUi",
  "smtp",
  "pop3",
  "functionsInspector",
] as const;
export type PortField = (typeof PORT_FIELDS)[number];

/** A concrete host/network port. Automatic assignment is represented by listeners, not here. */
export const NetworkPortSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
);
export type NetworkPort = Schema.Schema.Type<typeof NetworkPortSchema>;

export const StackEndpointSchema = Schema.Struct({
  protocol: Schema.Literals(["http", "tcp"] as const),
  address: Schema.String,
  port: NetworkPortSchema,
  url: Schema.String,
});
export type StackEndpoint = Schema.Schema.Type<typeof StackEndpointSchema>;

export const StackEndpointsSchema = Schema.Struct({
  api: Schema.optionalKey(StackEndpointSchema),
  database: Schema.optionalKey(StackEndpointSchema),
  pooler: Schema.optionalKey(StackEndpointSchema),
  studio: Schema.optionalKey(StackEndpointSchema),
  mailUi: Schema.optionalKey(StackEndpointSchema),
  smtp: Schema.optionalKey(StackEndpointSchema),
  pop3: Schema.optionalKey(StackEndpointSchema),
  functionsInspector: Schema.optionalKey(StackEndpointSchema),
});

export const CapabilityVersionsSchema = Schema.Struct({
  database: Schema.optionalKey(Schema.String),
  rest: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.String),
  realtime: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
  functions: Schema.optionalKey(Schema.String),
  studio: Schema.optionalKey(Schema.String),
  mail: Schema.optionalKey(Schema.String),
  analytics: Schema.optionalKey(Schema.String),
  pooler: Schema.optionalKey(Schema.String),
});

const CompleteCapabilityStatusesSchema = Schema.Array(CapabilityStatusSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((capabilities) =>
      Effect.succeed(
        capabilities.length === CAPABILITY_NAMES.length &&
          new Set(capabilities.map(({ name }) => name)).size === CAPABILITY_NAMES.length &&
          CAPABILITY_NAMES.every((name) =>
            capabilities.some((capability) => capability.name === name),
          )
          ? undefined
          : "Expected exactly one status for each public capability",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

export const StackStatusSchema = Schema.Struct({
  id: StackIdSchema,
  lifecycle: StackLifecycleSchema,
  desiredLifecycle: DesiredStackLifecycleSchema,
  runtime: StackRuntimeSchema,
  desiredGeneration: Schema.optionalKey(Schema.Finite),
  endpoints: StackEndpointsSchema,
  versions: CapabilityVersionsSchema,
  capabilities: CompleteCapabilityStatusesSchema,
});

export interface StackStatus {
  readonly id: StackId;
  readonly lifecycle: StackLifecycle;
  readonly desiredLifecycle: DesiredStackLifecycle;
  readonly runtime: StackRuntime;
  readonly desiredGeneration?: number;
  readonly endpoints: Readonly<Partial<Record<PortField, StackEndpoint>>>;
  readonly versions: Readonly<Partial<Record<CapabilityName, string>>>;
  readonly capabilities: ReadonlyArray<CapabilityStatus>;
}

export const StackDescriptorSchema = Schema.Struct({
  id: StackIdSchema,
  projectRoot: Schema.String,
  name: Schema.String,
  branchContext: Schema.String,
  runtime: StackRuntimeSchema,
  desiredLifecycle: DesiredStackLifecycleSchema,
});
export type StackDescriptor = Schema.Schema.Type<typeof StackDescriptorSchema>;

export const StackInspectionSchema = Schema.Struct({
  descriptor: StackDescriptorSchema,
  owner: Schema.Literals(["running", "absent", "unreachable", "incompatible"] as const),
  status: Schema.optionalKey(StackStatusSchema),
});
export type StackInspection = Schema.Schema.Type<typeof StackInspectionSchema>;

export type { ActivationMode };
export { ActivationModeSchema };
