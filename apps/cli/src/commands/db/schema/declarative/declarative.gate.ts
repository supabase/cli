import { Effect } from "effect";

import { aqua, bold } from "../../../../command-internal/colors.ts";
import { DeclarativeNotEnabledError } from "./declarative.errors.ts";

/**
 * Whether the declarative (pg-delta) code paths are enabled: the gate is open when either the
 * global `--experimental` flag is set or `[experimental.pgdelta] enabled` resolves true (the
 * default), so it closes only on an explicit `enabled = false`.
 */
export function isPgDeltaEnabled(experimental: boolean, pgDeltaEnabled: boolean): boolean {
  return experimental || pgDeltaEnabled;
}

/**
 * The suggestion shown when the gate is closed. `configPath` is `supabase/config.toml`;
 * `aqua`/`bold` render plain when stderr is not a TTY.
 */
export function pgDeltaSuggestion(configPath: string): string {
  return `Pass ${aqua("--experimental")} to run declarative commands while ${aqua(
    "[experimental.pgdelta] enabled = false",
  )} is set in ${bold(configPath)}`;
}

/**
 * The pg-delta gate. Must run at the top of each declarative leaf handler's body, before that
 * handler's own mutually-exclusive-flags check — a closed gate wins over a flag conflict, not
 * the other way around.
 */
export const requirePgDelta = Effect.fnUntraced(function* (opts: {
  readonly experimental: boolean;
  readonly pgDeltaEnabled: boolean;
  readonly configPath: string;
}) {
  if (isPgDeltaEnabled(opts.experimental, opts.pgDeltaEnabled)) return;
  return yield* new DeclarativeNotEnabledError({
    message: "declarative commands require --experimental flag or pg-delta enabled in config",
    suggestion: pgDeltaSuggestion(opts.configPath),
  });
});
