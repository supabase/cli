import { Effect } from "effect";
import type { ContainerClaims, DirectoryClaims } from "../src/namespace/Claims.ts";
import type { PortError } from "../src/Ports.ts";

/**
 * No-op claims for tests that exercise container or directory creation without exercising the
 * namespace's reconcile loop itself (covered separately by the namespace's own test suite).
 */
export const noContainerClaims: ContainerClaims = {
  claim: () => Effect.void,
  unclaim: () => Effect.void,
};
export const noDirectoryClaims: DirectoryClaims = {
  claim: () => Effect.void,
  unclaim: () => Effect.void,
};

/** Stands in for the real per-user registry check in tests not exercising it (covered separately
 * by `Ports.integration.test.ts`). */
export const noPublicPortReservations = (_port: number): Effect.Effect<boolean, PortError> =>
  Effect.succeed(false);
