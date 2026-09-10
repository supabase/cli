import type { Effect } from "effect";
import { Context } from "effect";

/**
 * Command-scoped cell for additive top-level fields on the JSON/stream-json
 * error envelope. A command calls `set` before its handler can fail;
 * `jsonOutputLayer`/`streamJsonOutputLayer`'s `fail` reads it optionally via
 * `Effect.serviceOption`, so a command that never provides this layer is unaffected.
 *
 * Fields merge into the envelope root, next to `_tag`/`error` (json) or
 * `type`/`error`/`timestamp` (stream-json) — never inside `error`, which
 * stays the normalized failure shape.
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
