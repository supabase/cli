import { Predicate, Schema } from "effect";

/**
 * Any JSON number, including an overflowed value decoded as ±Infinity, so one out-of-range field
 * does not fail this schema's decode and drop the consent it reads.
 */
export const PersistedNumberSchema = Schema.declare(Predicate.isNumber);

const ConsentStateSchema = Schema.Literals(["granted", "denied"] as const);
export type ConsentState = Schema.Schema.Type<typeof ConsentStateSchema>;

export const TelemetryConfigSchema = Schema.Struct({
  consent: ConsentStateSchema,
  device_id: Schema.String,
  session_id: Schema.String,
  session_last_active: PersistedNumberSchema,
  distinct_id: Schema.optionalKey(Schema.String),
});
export type TelemetryConfig = Schema.Schema.Type<typeof TelemetryConfigSchema>;
