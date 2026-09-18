import { Schema } from "effect";
import type { StackIdentity } from "../identity/Identity.ts";
import { NetworkPortSchema } from "../public/Status.ts";

export const PersistedStackIdentitySchema = Schema.Struct({
  projectRoot: Schema.String,
  branchContext: Schema.String,
  stackName: Schema.String,
});
export type PersistedStackIdentity = Schema.Schema.Type<typeof PersistedStackIdentitySchema>;

export const HostPortAssignmentSchema = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("stack"),
    binding: Schema.Literals(["api", "api:internal"] as const),
    address: Schema.String,
    port: NetworkPortSchema,
    intent: Schema.Literals(["automatic", "exact"] as const),
  }),
  Schema.Struct({
    owner: Schema.Literal("instance"),
    instanceId: Schema.String.check(Schema.isNonEmpty()),
    binding: Schema.String.check(Schema.isNonEmpty()),
    address: Schema.String,
    port: NetworkPortSchema,
    intent: Schema.Literals(["automatic", "exact"] as const),
  }),
]);
export type HostPortAssignment = Schema.Schema.Type<typeof HostPortAssignmentSchema>;

/** A durable loopback endpoint used by the host gateway to reach one workload. */
export const PrivatePortAssignmentSchema = Schema.Struct({
  instanceId: Schema.String.check(Schema.isNonEmpty()),
  workloadId: Schema.String.check(Schema.isNonEmpty()),
  binding: Schema.String.check(Schema.isNonEmpty()),
  port: NetworkPortSchema,
});
export type PrivatePortAssignment = Schema.Schema.Type<typeof PrivatePortAssignmentSchema>;

/** Stable identity for one durable private workload binding. */
export const privateBindingKey = (
  assignment: Pick<PrivatePortAssignment, "instanceId" | "workloadId" | "binding">,
): string => `${assignment.instanceId}\u0000${assignment.workloadId}\u0000${assignment.binding}`;

const PersistedSecretEntrySchema = Schema.Struct({
  policy: Schema.Literals(["managed", "passthrough"] as const),
  value: Schema.String,
});
/** Secret slots are dynamic because function environment names are user-defined. */
export const PersistedSecretValuesSchema = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:/-]+$/)),
  PersistedSecretEntrySchema,
);
export type PersistedSecretValues = Schema.Schema.Type<typeof PersistedSecretValuesSchema>;

export const toPersistedIdentity = (identity: StackIdentity): PersistedStackIdentity => ({
  projectRoot: identity.projectRoot,
  branchContext: identity.branchContext,
  stackName: identity.stackName,
});
