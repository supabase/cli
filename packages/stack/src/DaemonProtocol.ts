import { Schema } from "effect";
import { StackStateSchema } from "./StateManager.ts";

const DaemonErrorCodeSchema = Schema.Literals([
  "SERVICE_NOT_FOUND",
  "SERVICE_NOT_READY",
  "STACK_BUILD_ERROR",
]);

export const DaemonErrorResponseSchema = Schema.Struct({
  code: DaemonErrorCodeSchema,
  error: Schema.String,
  service: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
});

export type DaemonErrorResponse = typeof DaemonErrorResponseSchema.Type;

export const DaemonMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), state: StackStateSchema }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
