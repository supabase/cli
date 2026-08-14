/**
 * The `-o`/`--output` values the feedback family accepts, validated by
 * `withLegacyCommandInstrumentation` exactly like `db query`'s restricted
 * `json|table|csv` enum. Feedback is TS-only: there is no Go struct behind its
 * acknowledgement payload, so the struct-spec-driven `-o yaml|toml` encoders
 * (which reproduce Go field names byte-for-byte) don't apply, and `env` has no
 * plausible consumer for a one-field receipt. `pretty` keeps the human text;
 * `json` emits the machine payload through `encodeGoJson`.
 */
export const LEGACY_FEEDBACK_OUTPUT_FORMATS = ["pretty", "json"] as const;
