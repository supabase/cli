import { Schema } from "effect";
import { CapabilityNameSchema, type CapabilityName } from "./Capability.ts";

export const LogCursorSchema = Schema.Struct({
  opaque: Schema.String,
});
export type LogCursor = Schema.Schema.Type<typeof LogCursorSchema>;

export const LogQuerySchema = Schema.Struct({
  capabilities: Schema.optionalKey(Schema.Array(CapabilityNameSchema)),
  cursor: Schema.optionalKey(LogCursorSchema),
  tail: Schema.optionalKey(Schema.Finite),
});
export type LogQuery = Schema.Schema.Type<typeof LogQuerySchema>;

export const LogOptionsSchema = Schema.Struct({
  capabilities: Schema.optionalKey(Schema.Array(CapabilityNameSchema)),
  follow: Schema.optionalKey(Schema.Boolean),
  cursor: Schema.optionalKey(LogCursorSchema),
  tail: Schema.optionalKey(Schema.Finite),
});
export type LogOptions = Schema.Schema.Type<typeof LogOptionsSchema>;

export const StackLogEntrySchema = Schema.Struct({
  cursor: LogCursorSchema,
  timestamp: Schema.String,
  source: Schema.Union([CapabilityNameSchema, Schema.Literals(["supervisor", "gateway"] as const)]),
  stream: Schema.Literals(["stdout", "stderr", "internal"] as const),
  message: Schema.String,
});
export type StackLogEntry = Schema.Schema.Type<typeof StackLogEntrySchema>;

export const StackLogBatchSchema = Schema.Struct({
  entries: Schema.Array(StackLogEntrySchema),
  cursor: LogCursorSchema,
  running: Schema.Boolean,
});
export type StackLogBatch = Schema.Schema.Type<typeof StackLogBatchSchema>;

export type StackLogSource = CapabilityName | "supervisor" | "gateway";
