/**
 * Debug-only phase-timing instrumentation for the shadow baseline cache
 * (`shadow-cache.ts`'s `baseline-export`/`baseline-restore`) and the shadow's readiness gate
 * (`health-check.ts`'s `legacyWaitForShadowReady`, which emits `ready-attempt`/`ready-wait`).
 * `SUPABASE_SHADOW_DEBUG` is the opt-in gate — with it unset every
 * helper here is a pure pass-through (not even a `Clock` read), so leaving instrumentation in
 * place costs one boolean check per call site and nothing else. This module changes nothing about
 * behavior, stdout, exit codes, or flags: it only ever writes to STDERR, and only when the env
 * var is set (Go-parity constraint — this is a TS-only debugging aid with no Go counterpart).
 *
 * Lives in its own leaf module, not inside `shadow-cache.ts` itself, so `shadow-database.ts` (the
 * `contrib_regression` template-database creation) and `health-check.ts` (the readiness gate) can
 * use the same timing primitive without an import cycle back through `shadow-cache.ts`, which
 * already imports from both of those modules.
 *
 * Every line has the fixed shape `shadow-debug: <phase> <ms>ms<detail>` — see
 * {@link legacyTimeShadowPhase}'s own doc comment for the `detail` contract.
 */

import { Clock, Effect, Result } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { legacyParseBoolEnv } from "../legacy-diff-engine.ts";

/** `SUPABASE_SHADOW_DEBUG` — the opt-in gate for shadow phase-timing instrumentation (default OFF). */
export const LEGACY_SHADOW_DEBUG_ENV = "SUPABASE_SHADOW_DEBUG";

/**
 * Whether shadow phase-timing debug lines are enabled for this invocation. Mirrors
 * `legacyShadowCacheEnabled`'s own env-parsing style (`shadow-cache.ts`, itself
 * `legacyParseBoolEnv` over `process.env`) — checked fresh on every call, never cached at module
 * load, so a test (or a long-lived process) that mutates `process.env` sees the change
 * immediately.
 */
export function legacyShadowDebugEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return legacyParseBoolEnv(env[LEGACY_SHADOW_DEBUG_ENV]);
}

/** Truncates a debug-line detail string to `maxLength` (default ~120, matching the brief's per-line budget), appending `…` when cut. */
export function legacyShadowDebugTruncate(message: string, maxLength = 120): string {
  return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}

/** `shadow-debug: <phase> <ms>ms<detail>\n` — the one line shape every emitter in this module produces. */
function legacyShadowDebugLine(phase: string, elapsedMs: number, detail: string): string {
  return `shadow-debug: ${phase} ${elapsedMs}ms${detail}\n`;
}

/**
 * Times `effect` and, only when {@link legacyShadowDebugEnabled}, emits one
 * `shadow-debug: <phase> <ms>ms<detail>` line to stderr via `Output.raw` once `effect` completes —
 * on success OR failure, so a failing phase's elapsed time is never silently lost.
 *
 * `phase` may be a thunk instead of a plain string for a label that is itself non-trivial to
 * build (e.g. embedding a SQL statement's first ~60 chars) — the thunk is only ever invoked when
 * debug is on, so a disabled run pays neither the label construction nor the `Clock` read.
 *
 * `detail` receives the effect's own {@link Result.Result} and returns the trailing text (e.g.
 * ` attempts=5` or ` error="..."`) appended after the bare `<ms>ms`; the default emits nothing
 * extra. A complete no-op when debug is off — the input `effect` is returned unchanged, so
 * leaving this wrapper in place costs exactly one boolean check per call site.
 */
export const legacyTimeShadowPhase = <A, E, R>(
  phase: string | (() => string),
  effect: Effect.Effect<A, E, R>,
  detail: (result: Result.Result<A, E>) => string = () => "",
): Effect.Effect<A, E, R | Output> => {
  if (!legacyShadowDebugEnabled()) return effect;
  const label = typeof phase === "function" ? phase() : phase;
  return Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const outcome = yield* Effect.result(effect);
    const elapsed = (yield* Clock.currentTimeMillis) - start;
    const output = yield* Output;
    yield* output.raw(legacyShadowDebugLine(label, elapsed, detail(outcome)), "stderr");
    return yield* Effect.fromResult(outcome);
  });
};
