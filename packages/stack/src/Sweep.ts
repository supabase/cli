import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { sweepTimeout } from "./HostProcess.ts";
import { StackIdSchema } from "./identity/StackId.ts";
import * as Owner from "./Owner.ts";
import { listStackLabels, resolveEngineTarget, type EngineTarget } from "./runtime/Container.ts";
import * as StackNamespace from "./StackNamespace.ts";

const isStackId = Schema.is(StackIdSchema);

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
 * Holds `id`'s lease until the scope closes, marking the hold so clients wait instead of
 * mistaking it for a starting owner. `false` when another process holds the lease.
 */
const holdLease = Effect.fn("Sweep.holdLease")(function* (
  state: StackNamespace.Interface,
  id: string,
) {
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
  return true;
});

/**
 * Cleans up a stack whose lease is free, holding that lease meanwhile. Removes the stack's
 * labelled containers, and destroys the stack when its lifetime is `session`. Returns `false`
 * when another process holds the lease.
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
      if (!(yield* holdLease(state, id))) return false;
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
 * Removes the containers a stack with no registration left behind on `engineTarget`, holding its
 * lease meanwhile; the stack's data in the shared database volume stays. Returns `held` when
 * another process holds the lease, `registered` when the stack is registered, and otherwise
 * `reclaimed`.
 */
export const reclaimDeletedStack = Effect.fn("Sweep.reclaimDeletedStack")(function* (options: {
  readonly state: StackNamespace.Interface;
  readonly stateRoot: string;
  readonly id: string;
  readonly engineTarget: EngineTarget;
}) {
  const { state, id } = options;
  const outcome = yield* Effect.scoped(
    Effect.gen(function* () {
      if (!(yield* holdLease(state, id))) return "held" as const;
      if ((yield* state.read(id)) !== undefined) return "registered" as const;
      const dataRoot = yield* StackNamespace.stackDataRootLabel(options.stateRoot, id);
      yield* Owner.sweepContainers({ id }, dataRoot, options.engineTarget);
      return "reclaimed" as const;
    }),
  ).pipe(Effect.timeout(sweepTimeout));
  yield* Effect.annotateCurrentSpan({ "sweep.outcome": outcome });
  return outcome;
});

/** The ids of stacks with containers on `target`'s engine labelled with a data root of `stateRoot`. */
export const leftBehindStackIds = Effect.fn("Sweep.leftBehindStackIds")(function* (
  stateRoot: string,
  target: EngineTarget,
) {
  const ids = new Set<string>();
  for (const { stackId, root } of yield* listStackLabels(target)) {
    if (ids.has(stackId) || !isStackId(stackId)) continue;
    if (root === (yield* StackNamespace.stackDataRootLabel(stateRoot, stackId))) ids.add(stackId);
  }
  return ids;
});

/**
 * Keeps stack-labelled containers and session stacks alive only while their lease is held: every
 * other stack of this state root whose lease is free is reclaimed. With an `engineTarget`, so is
 * every stack with no registration that left containers on that engine labelled with this state
 * root.
 */
export const sweepOrphans = Effect.fn("Sweep.orphans")(
  function* (options: {
    readonly state: StackNamespace.Interface;
    readonly stateRoot: string;
    readonly cacheRoot: string;
    readonly ownerId: string;
    readonly engineTarget?: EngineTarget;
  }) {
    const { state, stateRoot, cacheRoot, ownerId, engineTarget } = options;
    const registered = new Set<string>();
    for (const { id } of yield* state.list) {
      registered.add(id);
      if (id === ownerId) continue;
      yield* reclaimStack({ state, stateRoot, cacheRoot, id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Orphan sweep of stack ${id} failed`, cause),
        ),
      );
    }
    if (engineTarget !== undefined) {
      const leftBehind = yield* leftBehindStackIds(stateRoot, engineTarget).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Orphan sweep of ${engineTarget.engine} containers failed`, cause).pipe(
            Effect.as(new Set<string>()),
          ),
        ),
      );
      for (const id of leftBehind) {
        if (registered.has(id) || id === ownerId) continue;
        yield* reclaimDeletedStack({ state, stateRoot, id, engineTarget }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Orphan sweep of deleted stack ${id} failed`, cause),
          ),
        );
      }
    }
    yield* state.pruneDestroyed(ownerId);
  },
  Effect.catchCause((cause) => Effect.logWarning("Orphan sweep failed", cause)),
);
