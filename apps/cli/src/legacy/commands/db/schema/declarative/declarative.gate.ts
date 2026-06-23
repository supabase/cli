import { Effect } from "effect";

import { legacyAqua, legacyBold } from "../../../../shared/legacy-colors.ts";
import { LegacyDeclarativeNotEnabledError } from "./declarative.errors.ts";

/**
 * Whether the declarative (pg-delta) code paths are enabled. Mirrors Go's
 * `dbDeclarativeCmd.PersistentPreRunE` net effect
 * (`apps/cli-go/cmd/db_schema_declarative.go:49-77`): passing `--experimental`
 * force-enables pg-delta, so the gate is open when either the global
 * `--experimental` flag is set **or** `[experimental.pgdelta] enabled = true`
 * is present in `config.toml` (Go's `utils.IsPgDeltaEnabled`).
 */
export function legacyIsPgDeltaEnabled(experimental: boolean, pgDeltaEnabled: boolean): boolean {
  return experimental || pgDeltaEnabled;
}

/**
 * The `utils.CmdSuggestion` shown when the gate is closed, byte-matching Go's
 * `fmt.Sprintf(...)` (`:64-68`). `configPath` is `supabase/config.toml`
 * (`utils.ConfigPath`). `legacyAqua`/`legacyBold` render plain when stderr is
 * not a TTY, matching Go's lipgloss profile detection.
 */
export function legacyPgDeltaSuggestion(configPath: string): string {
  return `Either pass ${legacyAqua("--experimental")} or add ${legacyAqua(
    "[experimental.pgdelta]",
  )} with ${legacyAqua("enabled = true")} to ${legacyBold(configPath)}`;
}

/**
 * The Effect-CLI replacement for Go's `PersistentPreRunE` gate: invoke at the
 * top of each declarative leaf handler. Fails with
 * `LegacyDeclarativeNotEnabledError` (carrying the byte-exact message +
 * suggestion) when neither `--experimental` nor `[experimental.pgdelta]` enables
 * pg-delta.
 */
export const legacyRequirePgDelta = Effect.fnUntraced(function* (opts: {
  readonly experimental: boolean;
  readonly pgDeltaEnabled: boolean;
  readonly configPath: string;
}) {
  if (legacyIsPgDeltaEnabled(opts.experimental, opts.pgDeltaEnabled)) return;
  return yield* Effect.fail(
    new LegacyDeclarativeNotEnabledError({
      message: "declarative commands require --experimental flag or pg-delta enabled in config",
      suggestion: legacyPgDeltaSuggestion(opts.configPath),
    }),
  );
});
