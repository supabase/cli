import { Schema } from "effect";

const ConsentStateSchema = Schema.Literals(["granted", "denied"] as const);
export type ConsentState = Schema.Schema.Type<typeof ConsentStateSchema>;

export const TelemetryConfigSchema = Schema.Struct({
  consent: ConsentStateSchema,
  device_id: Schema.String,
  session_id: Schema.String,
  session_last_active: Schema.Number,
  distinct_id: Schema.optionalKey(Schema.String),
});
export type TelemetryConfig = Schema.Schema.Type<typeof TelemetryConfigSchema>;
