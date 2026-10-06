import { Context, DateTime, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { sweepTimeout } from "./HostProcess.ts";
import * as Owner from "./Owner.ts";
import { resolveEngineTarget } from "./runtime/Container.ts";
import * as StackNamespace from "./StackNamespace.ts";

/** Runs a dead session stack's own destroy path in this process while holding its lease. */
const destroyStack = Effect.fn("Sweep.destroyStack")(function* (
  state: StackNamespace.Interface,
  saved: StackNamespace.SavedStack,
  dataRoot: string,
  cacheRoot: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const engineTarget =
    saved.runtime === "native" ? undefined : yield* resolveEngineTarget(spawner, saved.runtime);
  const context = yield* Layer.build(
    Owner.layer({ saved, root: dataRoot, cacheRoot, engineTarget }).pipe(
      Layer.provide(Layer.succeed(StackNamespace.Service, state)),
    ),
  );
  yield* Context.get(context, Owner.Service).namespace.destroy;
});

/**
 * Cleans up a stack whose lease is free, holding that lease meanwhile and marking the hold so
 * clients wait instead of mistaking it for a starting owner. Removes the stack's labelled
 * containers, and destroys the stack when its lifetime is `session`. Returns `false` when
 * another process holds the lease.
 */
export const reclaimStack = Effect.fn("Sweep.reclaimStack")(function* (options: {
  readonly state: StackNamespace.Interface;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly id: string;
}) {
  const { state, id } = options;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* state
        .acquireLease(id)
        .pipe(Effect.catchTag("Namespace.LeaseHeldError", () => Effect.void));
      if (lease === undefined) return false;
      yield* Effect.addFinalizer(() => lease.retractHolder.pipe(Effect.ignore));
      yield* lease.publishHolder({
        role: "sweeper",
        pid: process.pid,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      const saved = yield* state.read(id);
      if (saved === undefined) return true;
      const dataRoot = yield* StackNamespace.resolveStackDataRoot(options.stateRoot, id);
      if (saved.lifetime === "session")
        yield* destroyStack(state, saved, dataRoot, options.cacheRoot);
      else {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const engineTarget =
          saved.runtime === "native"
            ? undefined
            : yield* resolveEngineTarget(spawner, saved.runtime);
        yield* Owner.sweepContainers(saved, dataRoot, engineTarget);
      }
      return true;
    }),
  ).pipe(Effect.timeout(sweepTimeout));
});

/**
 * Keeps stack-labelled containers and session stacks alive only while their lease is held: every
 * other stack of this state root whose lease is free is reclaimed.
 */
export const sweepOrphans = Effect.fn("Sweep.orphans")(
  function* (options: {
    readonly state: StackNamespace.Interface;
    readonly stateRoot: string;
    readonly cacheRoot: string;
    readonly ownerId: string;
  }) {
    for (const { id } of yield* options.state.list) {
      if (id === options.ownerId) continue;
      yield* reclaimStack({ ...options, id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Orphan sweep of stack ${id} failed`, cause),
        ),
      );
    }
    yield* options.state.pruneDestroyed(options.ownerId);
  },
  Effect.catchCause((cause) => Effect.logWarning("Orphan sweep failed", cause)),
);
