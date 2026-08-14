import type { Effect } from "effect";
import { Context } from "effect";

/**
 * Command-scoped cell for additive top-level fields on the JSON/stream-json
 * error envelope. A command that has already resolved some fact worth
 * surfacing to an agent — even when the command itself is about to fail —
 * calls `set` before its handler can fail; `jsonOutputLayer`/`streamJsonOutputLayer`'s
 * `fail` read it optionally via `Effect.serviceOption`, so a command that never
 * provides this layer renders the exact same envelope as today. `next/` never
 * provides it either, so this is completely inert there.
 *
 * Fields are spread onto the TOP LEVEL of the envelope, next to `_tag`/`error`
 * (json) or `type`/`error`/`timestamp` (stream-json) — never inside `error`
 * itself, since `error` stays the normalized failure shape callers already
 * depend on.
 */
interface MachineErrorContextShape {
  /** Merges `fields` into the envelope additions recorded so far. */
  readonly set: (fields: Record<string, unknown>) => Effect.Effect<void>;
  /** The additions recorded so far, or `{}` when nothing has been set. */
  readonly get: Effect.Effect<Record<string, unknown>>;
}

export class MachineErrorContext extends Context.Service<
  MachineErrorContext,
  MachineErrorContextShape
>()("supabase/output/MachineErrorContext") {}
