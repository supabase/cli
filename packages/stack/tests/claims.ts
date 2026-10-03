import { Effect } from "effect";
import type { ContainerClaims, DirectoryClaims } from "../src/namespace/Claims.ts";

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
