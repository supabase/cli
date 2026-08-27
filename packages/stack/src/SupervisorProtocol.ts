import { Schema } from "effect";
import { ControlSupervisorDescriptorSchema, ControlOwnerStateSchema } from "./DaemonProtocol.ts";
import { managedStackLaunchInputSchema } from "./managed/document.ts";
import { PORT_FIELDS } from "./PortCatalog.ts";

const portIntentSchema = Schema.Struct({
  activeFields: Schema.Array(Schema.Literals(PORT_FIELDS)),
  disabledFields: Schema.optionalKey(Schema.Array(Schema.Literals(PORT_FIELDS))),
  document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export const SupervisorStartCommandSchema = Schema.Struct({
  type: Schema.Literal("start"),
  replacement: Schema.optionalKey(Schema.Boolean),
  cliVersion: Schema.String,
  stackId: Schema.String,
  workspacePath: Schema.String,
  stackName: Schema.String,
  stateRoot: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
  portIntents: portIntentSchema,
  launch: Schema.optionalKey(managedStackLaunchInputSchema),
});
export type SupervisorStartMessage = Schema.Schema.Type<typeof SupervisorStartCommandSchema>;

const SupervisorOwnerDescriptorSchema = Schema.Struct({
  kind: Schema.Literal("supervisor"),
  ownershipId: ControlSupervisorDescriptorSchema.fields.ownershipId,
  ownerSessionId: ControlSupervisorDescriptorSchema.fields.ownerSessionId,
  controlProtocolVersion: ControlSupervisorDescriptorSchema.fields.controlProtocolVersion,
  daemonCliVersion: ControlSupervisorDescriptorSchema.fields.daemonCliVersion,
  state: ControlOwnerStateSchema,
  ready: Schema.Boolean,
});

export const SupervisorStartedEventSchema = Schema.Struct({
  type: Schema.Literal("started"),
  endpoint: Schema.Struct({
    hostname: Schema.String,
    port: Schema.Number,
    url: Schema.String,
  }),
  owner: SupervisorOwnerDescriptorSchema,
  attached: Schema.optionalKey(Schema.Boolean),
});
export type SupervisorStartedMessage = Schema.Schema.Type<typeof SupervisorStartedEventSchema>;

export const SupervisorErrorEventSchema = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
  errorCode: Schema.optionalKey(Schema.Literal("DAEMON_UPGRADE_REQUIRED")),
  stackId: Schema.optionalKey(Schema.String),
  oldCliVersion: Schema.optionalKey(Schema.String),
  newCliVersion: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(ControlOwnerStateSchema),
  ready: Schema.optionalKey(Schema.Boolean),
});
export type SupervisorErrorMessage = Schema.Schema.Type<typeof SupervisorErrorEventSchema>;

export const SupervisorEventSchema = Schema.Union([
  SupervisorStartedEventSchema,
  SupervisorErrorEventSchema,
]);
