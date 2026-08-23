import { Schema } from "effect";
import { ControlOwnerDescriptorSchema } from "./DaemonProtocol.ts";
import { managedStackLaunchInputSchema } from "./managed/document.ts";
import { PORT_FIELDS } from "./PortCatalog.ts";

const portIntentSchema = Schema.Struct({
  activeFields: Schema.Array(Schema.Literals(PORT_FIELDS)),
  disabledFields: Schema.optionalKey(Schema.Array(Schema.Literals(PORT_FIELDS))),
  document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

export const SupervisorStartCommandSchema = Schema.Struct({
  type: Schema.Literal("start"),
  buildIdentity: Schema.Struct({
    cliVersion: Schema.String,
    buildId: Schema.String,
  }),
  incompatibleOwnerPolicy: Schema.Literals(["replace", "fail"]),
  stackId: Schema.String,
  workspacePath: Schema.String,
  stackName: Schema.String,
  stateRoot: Schema.String,
  config: Schema.Record(Schema.String, Schema.Json),
  portIntents: portIntentSchema,
  launch: Schema.optionalKey(managedStackLaunchInputSchema),
});

/** Parent acknowledgement required before an incompatible owner is fenced. */
export const SupervisorReplacementAckCommandSchema = Schema.Struct({
  type: Schema.Literal("replacement-ack"),
});

const SupervisorOwnerDescriptorSchema = Schema.Struct({
  ownershipId: ControlOwnerDescriptorSchema.fields.ownershipId,
  ownerSessionId: ControlOwnerDescriptorSchema.fields.ownerSessionId,
  controlProtocolVersion: ControlOwnerDescriptorSchema.fields.controlProtocolVersion,
  daemonCliVersion: ControlOwnerDescriptorSchema.fields.daemonCliVersion,
  daemonBuildId: ControlOwnerDescriptorSchema.fields.daemonBuildId,
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

export const SupervisorReplacingEventSchema = Schema.Struct({
  type: Schema.Literal("replacing"),
  stackId: Schema.String,
  oldCliVersion: Schema.String,
  oldBuildId: Schema.String,
  newCliVersion: Schema.String,
  newBuildId: Schema.String,
});

export const SupervisorErrorEventSchema = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
  errorCode: Schema.optionalKey(Schema.Literal("DAEMON_UPGRADE_REQUIRED")),
  stackId: Schema.optionalKey(Schema.String),
  oldCliVersion: Schema.optionalKey(Schema.String),
  oldBuildId: Schema.optionalKey(Schema.String),
  newCliVersion: Schema.optionalKey(Schema.String),
  newBuildId: Schema.optionalKey(Schema.String),
});

export const SupervisorEventSchema = Schema.Union([
  SupervisorStartedEventSchema,
  SupervisorReplacingEventSchema,
  SupervisorErrorEventSchema,
]);
