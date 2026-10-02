import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import * as State from "../../src/State.ts";

/** The state root every integration test that binds a real auto-allocated port shares. */
export const sharedStateRoot = (): string => inject("stackStateRoot");

/**
 * The shared root's current port claims, so a test's own public or native backend port
 * reservation skips ports a sibling test's stack already saved there.
 */
export const sharedPortClaims: Effect.Effect<ReadonlyArray<State.StackClaims>, State.StateError> =
  Effect.scoped(
    Layer.build(State.layer({ root: sharedStateRoot() })).pipe(
      Effect.flatMap((context) => Context.get(context, State.Service).claims),
    ),
  ).pipe(Effect.provide(NodeServices.layer));

/**
 * A stack id unique to this call, safe for `State`'s id pattern (`SafeId` in `src/State.ts`) and
 * short enough to fit the 64-character stack id native services enforce (`src/services/Database.ts`).
 */
export const uniqueStackId = (prefix: string): string =>
  `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
