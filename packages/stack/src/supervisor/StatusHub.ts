import { Effect, Stream, SubscriptionRef } from "effect";
import type { StackStatus } from "../public/Status.ts";

/**
 * In-memory complete status projection shared by a supervisor and its clients.
 *
 * `changes` starts each subscriber with the current snapshot and then emits
 * every complete replacement. SubscriptionRef provides the serialization and
 * broadcast semantics; no per-subscriber waiter bookkeeping is required.
 */
export interface StatusHub {
  readonly current: Effect.Effect<StackStatus>;
  readonly publish: (status: StackStatus) => Effect.Effect<void>;
  readonly changes: Stream.Stream<StackStatus>;
}

export const makeStatusHub = (initial: StackStatus): Effect.Effect<StatusHub> =>
  Effect.map(SubscriptionRef.make(initial), (ref) => ({
    current: SubscriptionRef.get(ref),
    publish: (status: StackStatus) => SubscriptionRef.set(ref, status),
    changes: SubscriptionRef.changes(ref),
  }));
