import { randomUUID } from "node:crypto";
import { inject } from "vitest";

/** The state root every integration test that binds a real auto-allocated port shares. */
export const sharedStateRoot = (): string => inject("stackStateRoot");

/**
 * A stack id unique to this call, safe for `State`'s id pattern (`SafeId` in `src/State.ts`) and
 * short enough to fit the 64-character stack id native services enforce (`src/services/Database.ts`).
 */
export const uniqueStackId = (prefix: string): string =>
  `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
