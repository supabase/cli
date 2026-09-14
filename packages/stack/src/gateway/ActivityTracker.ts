import { Effect } from "effect";
import type { CapabilityName } from "../public/Capability.ts";

/** Tracks gateway work that must keep a lazy capability running. */
export interface GatewayActivity {
  readonly track: <A, E>(
    capability: CapabilityName,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

export interface GatewayActivityCallbacks {
  readonly begin: (capability: CapabilityName) => Effect.Effect<void>;
  readonly end: (capability: CapabilityName) => Effect.Effect<void>;
}

/** Adapts gateway lifetimes to the Supervisor-owned traffic controller. */
export const makeGatewayActivity = (
  callbacks: GatewayActivityCallbacks,
): Effect.Effect<GatewayActivity> =>
  Effect.succeed({
    track: (capability, effect) =>
      Effect.acquireUseRelease(
        callbacks.begin(capability),
        () => effect,
        () => callbacks.end(capability),
      ),
  } satisfies GatewayActivity);
