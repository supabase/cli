import { Context, type Effect } from "effect";

interface RandomShape {
  /**
   * Returns `bytes` cryptographically-random bytes, hex-encoded (lowercase).
   * Injectable so tests can pin a deterministic value.
   */
  readonly randomHex: (bytes: number) => Effect.Effect<string>;
}

export class Random extends Context.Service<Random, RandomShape>()("supabase/runtime/Random") {}
