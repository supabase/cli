import { Effect } from "effect";
import type { CapabilityName } from "../public/Capability.ts";
import { GatewayActivationError } from "../public/Errors.ts";

/** Tracks gateway work that must keep a lazy capability running. */
export interface GatewayActivity {
  readonly track: <A, E>(
    capability: CapabilityName,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | GatewayActivationError>;
}

export interface GatewayActivityCallbacks<Lease> {
  readonly begin: (capability: CapabilityName) => Effect.Effect<Lease>;
  readonly end: (capability: CapabilityName, lease: Lease) => Effect.Effect<void>;
}

/** Adapts gateway lifetimes to the Supervisor-owned traffic controller. */
export const makeGatewayActivity = <Lease>(
  callbacks: GatewayActivityCallbacks<Lease>,
): Effect.Effect<GatewayActivity> =>
  Effect.succeed({
    track: (capability, effect) =>
      Effect.acquireUseRelease(
        callbacks.begin(capability),
        () => effect,
        (lease) => callbacks.end(capability, lease),
      ),
  } satisfies GatewayActivity);
