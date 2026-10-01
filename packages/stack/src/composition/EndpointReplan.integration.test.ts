import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { claimantOf } from "../Ports.ts";
import * as State from "../State.ts";
import { restoreFailedEndpointReplan } from "./EndpointReplan.ts";

const stateFor = (root: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(State.layer({ root }));
    return Context.get(context, State.Service);
  });

const fixedPort = 24_718;

const registeredStack = (root: string): State.SavedStack => ({
  id: "stack-a",
  lifetime: "detached",
  identity: { projectRoot: root, branchContext: "main", stackName: "replan-atomic" },
  runtime: "native",
  instances: [
    {
      id: "rest-1",
      creation: { service: "rest", config: {}, endpoints: { http: { port: fixedPort } } },
    },
  ],
  composition: { members: [{ id: "rest-1", activation: "eager" }], dependencies: [] },
  ports: [{ key: "api", host: "127.0.0.1", port: fixedPort }],
});

/** Claims a port for another stack, through the same registry check the restore uses, only if no other stack already holds it. */
const claimIfFree = (state: State.Interface, stackId: string, port: number) =>
  state.withLock(
    Effect.gen(function* () {
      const current: State.SavedStack = (yield* state.read(stackId)) ?? {
        id: stackId,
        lifetime: "detached",
        identity: { projectRoot: "/tmp", branchContext: "main", stackName: stackId },
        runtime: "native",
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      };
      const others = yield* state.claims;
      if (claimantOf(others, stackId, port) !== undefined) return false;
      yield* state.save({
        ...current,
        ports: [...current.ports, { key: "other", host: "127.0.0.1", port }],
      });
      return true;
    }),
  );

/**
 * Forces another stack's lock-protected claim on the restored port to commit before the restore's
 * own lock is taken, through a thin wrapper around the existing `State.Interface.withLock` seam:
 * no new production hook, no sleeps. Reading other stacks' claims inside that same lock, as the
 * fix does, then sees the committed claim; reading them before taking the lock does not.
 */
it.live(
  "restores the saved document without overlapping a claim another stack committed first",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "endpoint-replan-atomic-" });
        const stateA = yield* stateFor(root);
        const stateB = yield* stateFor(root);

        // `registered` is the pre-re-plan snapshot kept only for the restore to fall back to; the
        // stack's own live document already has the touched "api" claim dropped, matching the
        // real mid-re-plan state the owner's startup leaves behind before it fails.
        const registered = registeredStack(root);
        yield* stateA.save({
          ...registered,
          ports: registered.ports.filter((claim) => claim.key !== "api"),
        });

        const otherClaimReady = yield* Deferred.make<void>();
        const otherClaimDone = yield* Deferred.make<boolean>();
        const otherClaim = yield* Deferred.await(otherClaimReady).pipe(
          Effect.andThen(claimIfFree(stateB, "stack-b", fixedPort)),
          Effect.tap((claimed) => Deferred.succeed(otherClaimDone, claimed)),
          Effect.forkChild,
        );
        const wrappedStateA: State.Interface = {
          ...stateA,
          withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Deferred.succeed(otherClaimReady, undefined).pipe(
              Effect.andThen(Deferred.await(otherClaimDone)),
              Effect.andThen(stateA.withLock(effect)),
            ),
        };

        yield* restoreFailedEndpointReplan(wrappedStateA, registered, [{ key: "api" }]);
        const claimedByOther = yield* Fiber.join(otherClaim);
        expect(claimedByOther).toBe(true);

        const afterA = yield* stateA.read("stack-a");
        const afterB = yield* stateA.read("stack-b");
        expect(afterB?.ports).toEqual([{ key: "other", host: "127.0.0.1", port: fixedPort }]);
        expect(afterA?.ports).toEqual([]);
        expect(afterA?.instances).toEqual(registered.instances);
        expect(afterA?.composition).toEqual(registered.composition);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
