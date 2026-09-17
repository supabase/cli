import { Effect, Schema, SchemaGetter } from "effect";
import { StackIdSchema, type StackId } from "./StackId.ts";
import {
  ActivationModeSchema,
  CapabilityNameSchema,
  CapabilityStatusSchema,
  type ActivationMode,
  type CapabilityName,
  type CapabilityStatus,
} from "./Capability.ts";
import { StackRuntimeSchema, type StackRuntime } from "./Runtime.ts";
import { ServiceInstanceIdSchema } from "./ServiceInstanceId.ts";
/** Recovery guidance exposed when a failed cleanup blocks new workload activation. */
export const StackRecoverySchema = Schema.Struct({
  operation: Schema.Literals(["stop", "destroy"] as const),
  message: Schema.String,
});
export type StackRecovery = Schema.Schema.Type<typeof StackRecoverySchema>;

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

export const PORT_FIELD_PROTOCOL: Readonly<Record<PortField, "http" | "tcp">> = {
  api: "http",
  database: "tcp",
  pooler: "tcp",
  studio: "http",
  mailUi: "http",
  smtp: "tcp",
  pop3: "tcp",
  functionsInspector: "http",
};

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

/** Observable state of preparing one workload artifact for a running stack. */
export const ArtifactPreparationStateSchema = Schema.Literals([
  "queued",
  "preparing",
  "downloading",
  "ready",
  "failed",
] as const);
export type ArtifactPreparationState = Schema.Schema.Type<typeof ArtifactPreparationStateSchema>;

export const ArtifactPreparationStatusSchema = Schema.Struct({
  workloadId: Schema.String,
  capability: CapabilityNameSchema,
  state: ArtifactPreparationStateSchema,
  error: Schema.optionalKey(Schema.String),
});
export type ArtifactPreparationStatus = Schema.Schema.Type<typeof ArtifactPreparationStatusSchema>;

/** Preparation progress attributed to the instance that consumes the artifact. */
export const InstanceArtifactPreparationStatusSchema = Schema.Struct({
  workloadId: Schema.String,
  instanceId: ServiceInstanceIdSchema,
  capability: CapabilityNameSchema,
  state: ArtifactPreparationStateSchema,
  artifactIdentity: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type InstanceArtifactPreparationStatus = Schema.Schema.Type<
  typeof InstanceArtifactPreparationStatusSchema
>;

const CapabilityStatusesSchema = Schema.Array(CapabilityStatusSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((capabilities) =>
      Effect.succeed(
        new Set(capabilities.map(({ name }) => name)).size === capabilities.length
          ? undefined
          : "Expected at most one status for each public capability",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

export const ServiceEndpointAvailabilitySchema = Schema.Literals([
  "planned",
  "listening",
  "unavailable",
] as const);
export type ServiceEndpointAvailability = Schema.Schema.Type<
  typeof ServiceEndpointAvailabilitySchema
>;

export const ServiceEndpointStatusSchema = Schema.Struct({
  binding: Schema.String,
  protocol: Schema.Literals(["http", "tcp"] as const),
  address: Schema.String,
  port: NetworkPortSchema,
  url: Schema.String,
  availability: ServiceEndpointAvailabilitySchema,
});
export type ServiceEndpointStatus = Schema.Schema.Type<typeof ServiceEndpointStatusSchema>;

export const ServiceFailureSchema = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  instanceId: Schema.optionalKey(ServiceInstanceIdSchema),
  operationId: Schema.optionalKey(Schema.String),
});
export type ServiceFailure = Schema.Schema.Type<typeof ServiceFailureSchema>;

export const ServicePendingOperationSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "start",
    "sleep",
    "stop",
    "restart",
    "destroy",
    "exportSnapshot",
    "restoreSnapshot",
  ] as const),
});
export type ServicePendingOperation = Schema.Schema.Type<typeof ServicePendingOperationSchema>;

export const ServiceStatusSchema = Schema.Struct({
  id: ServiceInstanceIdSchema,
  service: CapabilityNameSchema,
  name: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  intent: Schema.Literals(["started", "stopped"] as const),
  phase: Schema.Literals([
    "stopped",
    "dormant",
    "starting",
    "ready",
    "stopping",
    "failed",
    "recovery",
  ] as const),
  activation: ActivationModeSchema,
  pendingOperation: Schema.optionalKey(ServicePendingOperationSchema),
  endpoints: Schema.Array(ServiceEndpointStatusSchema),
  error: Schema.optionalKey(ServiceFailureSchema),
  recovery: Schema.optionalKey(StackRecoverySchema),
});
export type ServiceStatus = Schema.Schema.Type<typeof ServiceStatusSchema>;

export const StackStatusSchema = Schema.Struct({
  id: StackIdSchema,
  lifecycle: StackLifecycleSchema,
  desiredLifecycle: DesiredStackLifecycleSchema,
  runtime: StackRuntimeSchema,
  endpoints: StackEndpointsSchema,
  versions: CapabilityVersionsSchema,
  capabilities: CapabilityStatusesSchema,
  artifacts: Schema.Array(InstanceArtifactPreparationStatusSchema),
  instances: Schema.Array(ServiceStatusSchema),
  recovery: Schema.optionalKey(StackRecoverySchema),
});

export interface StackStatus {
  readonly id: StackId;
  readonly lifecycle: StackLifecycle;
  readonly desiredLifecycle: DesiredStackLifecycle;
  readonly runtime: StackRuntime;
  readonly endpoints: Readonly<Partial<Record<PortField, StackEndpoint>>>;
  readonly versions: Readonly<Partial<Record<CapabilityName, string>>>;
  readonly capabilities: ReadonlyArray<CapabilityStatus>;
  readonly artifacts: ReadonlyArray<InstanceArtifactPreparationStatus>;
  readonly instances: ReadonlyArray<ServiceStatus>;
  readonly recovery?: StackRecovery;
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
  configDrift: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["unchanged", "changed", "unconfigured"] as const),
      paths: Schema.Array(Schema.String),
    }),
  ),
});
export type StackInspection = Schema.Schema.Type<typeof StackInspectionSchema>;

export type { ActivationMode };
export { ActivationModeSchema };
