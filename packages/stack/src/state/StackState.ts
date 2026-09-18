import { Schema } from "effect";
import {
  HostPortAssignmentSchema,
  PrivatePortAssignmentSchema,
  PersistedSecretValuesSchema,
  PersistedStackIdentitySchema,
} from "./StackStatePrimitives.ts";
import { PersistedServiceRegistrySchema } from "../model/ServiceRegistry.ts";
import { StackRuntimeSchema } from "../public/Runtime.ts";
import { ListenerConfigSchema } from "../public/Config.ts";

export const STACK_STATE_FORMAT = "supabase-stack-state-v2" as const;

const PersistedJwtSigningSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("symmetric"),
    secret: Schema.Struct({ slot: Schema.String.check(Schema.isNonEmpty()) }),
  }),
  Schema.Struct({
    kind: Schema.Literal("jwks-file"),
    path: Schema.String.check(Schema.isNonEmpty()),
  }),
]);
const PersistedSharedSecuritySchema = Schema.Struct({
  jwt: Schema.Struct({
    issuer: Schema.NullOr(Schema.String),
    expirySeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    signing: PersistedJwtSigningSchema,
  }),
});
const PersistedSharedListenersSchema = Schema.Struct({
  api: Schema.optionalKey(ListenerConfigSchema),
});

/** Canonical durable state keeps shared stack material separate from service instances. */
export const PersistedStackStateSchema = Schema.Struct({
  format: Schema.Literal(STACK_STATE_FORMAT),
  identity: PersistedStackIdentitySchema,
  runtime: StackRuntimeSchema,
  preparation: Schema.Literals(["background", "on-demand"] as const),
  security: PersistedSharedSecuritySchema,
  listeners: PersistedSharedListenersSchema,
  registry: PersistedServiceRegistrySchema,
  ports: Schema.Array(HostPortAssignmentSchema),
  privatePorts: Schema.Array(PrivatePortAssignmentSchema),
  secrets: PersistedSecretValuesSchema,
});
export type PersistedStackState = Schema.Schema.Type<typeof PersistedStackStateSchema>;

/** Validates host bindings and the native runtime's shared loopback namespace. */
export const validatePortAssignments = (
  state: Pick<PersistedStackState, "runtime" | "ports" | "privatePorts">,
): string | undefined => {
  const hostBindings = new Set<string>();
  for (const assignment of state.ports) {
    const key = `${assignment.address}\u0000${assignment.port}`;
    if (hostBindings.has(key))
      return `Port overlap: duplicate host binding ${assignment.address}:${assignment.port}`;
    hostBindings.add(key);
  }
  if (state.runtime.kind !== "native") return undefined;
  const privatePorts = new Set<number>();
  for (const assignment of state.privatePorts) {
    if (privatePorts.has(assignment.port))
      return `Port overlap: duplicate native private binding ${assignment.port}`;
    privatePorts.add(assignment.port);
    if ([...state.ports].some((host) => host.port === assignment.port))
      return `Port overlap: native host/private binding ${assignment.port}`;
  }
  return undefined;
};

export { privateBindingKey, toPersistedIdentity } from "./StackStatePrimitives.ts";
export type {
  HostPortAssignment,
  PrivatePortAssignment,
  PersistedSecretValues,
} from "./StackStatePrimitives.ts";
