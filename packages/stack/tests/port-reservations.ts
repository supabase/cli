import { Effect } from "effect";
import type { PortError } from "../src/Ports.ts";

/** Stands in for the real per-user registry check in tests not exercising it (covered separately
 * by `Ports.integration.test.ts`). */
export const noPublicPortReservations = (_port: number): Effect.Effect<boolean, PortError> =>
  Effect.succeed(false);
