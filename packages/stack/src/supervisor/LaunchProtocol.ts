import { Schema } from "effect";
import { OwnerSessionIdSchema } from "../control/MaintenanceProtocol.ts";
import { StackIdSchema } from "../public/StackId.ts";

/** JSON payload shared by the detached launcher and Supervisor entrypoint. */
export const SupervisorArgsSchema = Schema.Struct({
  stateRoot: Schema.String,
  artifactCacheRoot: Schema.optional(Schema.String),
  tempRoot: Schema.String,
  platform: Schema.Literals(["posix", "windows"] as const),
  stackId: StackIdSchema,
  ownerSessionId: OwnerSessionIdSchema,
});

export type SupervisorArgs = Schema.Schema.Type<typeof SupervisorArgsSchema>;

/** One-line readiness frame written by the Supervisor on fd3. */
export const SupervisorReadySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    stackId: StackIdSchema,
    ownerSessionId: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals(["ownership-conflict", "failed"] as const),
    message: Schema.String,
  }),
]);

export type SupervisorReady = Schema.Schema.Type<typeof SupervisorReadySchema>;
