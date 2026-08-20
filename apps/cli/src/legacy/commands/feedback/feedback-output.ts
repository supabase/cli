/**
 * The `-o`/`--output` values the feedback family accepts, validated by
 * `withLegacyCommandInstrumentation` exactly like `db query`'s restricted
 * `json|table|csv` enum. The `-o yaml|toml` encoders are driven by
 * `*.go-payload.ts` struct specs, which the feedback acknowledgement has no
 * reason to define, and `env` has no plausible consumer for a one-field
 * receipt. `pretty` keeps the human text; `json` emits the machine payload
 * through `encodeGoJson`.
 */
export const LEGACY_FEEDBACK_OUTPUT_FORMATS = ["pretty", "json"] as const;
