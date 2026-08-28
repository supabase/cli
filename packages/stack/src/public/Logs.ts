import { Schema } from "effect";
import { CapabilityNameSchema, type CapabilityName } from "./Capability.ts";

export const LogCursorSchema = Schema.Struct({
  opaque: Schema.String,
});
export type LogCursor = Schema.Schema.Type<typeof LogCursorSchema>;

export const LogOptionsSchema = Schema.Struct({
  capabilities: Schema.optionalKey(Schema.Array(CapabilityNameSchema)),
  follow: Schema.optionalKey(Schema.Boolean),
  cursor: Schema.optionalKey(LogCursorSchema),
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

export type StackLogSource = CapabilityName | "supervisor" | "gateway";
