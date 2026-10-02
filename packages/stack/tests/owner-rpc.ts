import { Context, Effect, Layer } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import * as Owner from "../src/Owner.ts";
import { OwnerRpc } from "../src/Rpc.ts";
import { Service as StateService } from "../src/State.ts";
import type { Interface as StateInterface, SavedStack } from "../src/State.ts";

/** Builds an in-process owner and an RPC client bound to its handlers. */
export const ownerFor = (options: {
  readonly saved: SavedStack;
  readonly state: StateInterface;
  readonly root: string;
  readonly cacheRoot: string;
}) =>
  Effect.gen(function* () {
    const { state, ...layerOptions } = options;
    const context = yield* Layer.build(
      Owner.layer(layerOptions).pipe(Layer.provide(Layer.succeed(StateService, state))),
    );
    const owner = Context.get(context, Owner.Service);
    const rpc = yield* RpcTest.makeClient(OwnerRpc).pipe(
      Effect.provide(OwnerRpc.toLayer(owner.handlers)),
    );
    return { rpc, namespace: owner.namespace, getStackCredentials: owner.getStackCredentials };
  });

/**
 * Registers a stack the way the product owner does: takes its lease for the enclosing scope,
 * then saves it, so an in-process owner double built with `ownerFor` holds the lease like
 * production. Call once per logical stack, before any fault-injecting wrapper around `state`.
 */
export const registerLeased = (state: StateInterface, saved: SavedStack) =>
  Effect.gen(function* () {
    const held = yield* state.lease(saved.id);
    if (!held) return yield* Effect.die(`Could not take the lease for stack ${saved.id}`);
    yield* state.save(saved);
  });
