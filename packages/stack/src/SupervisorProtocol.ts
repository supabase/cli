import { Schema } from "effect";
import { ControlOwnerDescriptorSchema } from "./DaemonProtocol.ts";
import { managedStackLaunchInputSchema } from "./managed/document.ts";
import { PORT_FIELDS } from "./PortCatalog.ts";

const portIntentSchema = Schema.Struct({
  activeFields: Schema.Array(Schema.Literals(PORT_FIELDS)),
  disabledFields: Schema.optionalKey(Schema.Array(Schema.Literals(PORT_FIELDS))),
  document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export const SupervisorStartCommandSchema = Schema.Struct({
  type: Schema.Literals(["start", "upgrade-restart"]),
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
  ownershipId: ControlOwnerDescriptorSchema.fields.ownershipId,
  ownerSessionId: ControlOwnerDescriptorSchema.fields.ownerSessionId,
  controlProtocolVersion: ControlOwnerDescriptorSchema.fields.controlProtocolVersion,
  daemonCliVersion: ControlOwnerDescriptorSchema.fields.daemonCliVersion,
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
  errorCode: Schema.optionalKey(
    Schema.Literals([
      "DAEMON_UPGRADE_REQUIRED",
      "UPGRADE_PREFLIGHT",
      "UPGRADE_RESTART",
      "STOP_TIMEOUT",
    ]),
  ),
  stackId: Schema.optionalKey(Schema.String),
  oldCliVersion: Schema.optionalKey(Schema.String),
  newCliVersion: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  ownerSessionId: Schema.optionalKey(Schema.String),
});
export type SupervisorErrorMessage = Schema.Schema.Type<typeof SupervisorErrorEventSchema>;

export const SupervisorEventSchema = Schema.Union([
  SupervisorStartedEventSchema,
  SupervisorErrorEventSchema,
]);
