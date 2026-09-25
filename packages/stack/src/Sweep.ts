import { Context, DateTime, Effect, FileSystem, Layer, Path } from "effect";
import { sweepTimeout } from "./HostProcess.ts";
import * as Owner from "./Owner.ts";
import * as State from "./State.ts";

/** Runs a dead session stack's own destroy path in this process while holding its lease. */
const destroyStack = Effect.fn("Sweep.destroyStack")(function* (
  state: State.Interface,
  saved: State.SavedStack,
  dataRoot: string,
  cacheRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dataRoot, { recursive: true });
  const context = yield* Layer.build(
    Owner.layer({ saved, root: dataRoot, cacheRoot }).pipe(
      Layer.provide(Layer.succeed(State.Service, state)),
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
  readonly state: State.Interface;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly id: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { state, id } = options;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      if (!(yield* state.lease(id))) return false;
      yield* Effect.addFinalizer(() => state.retractHolder(id).pipe(Effect.ignore));
      yield* state.publishHolder(id, {
        role: "sweeper",
        pid: process.pid,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      const saved = yield* state.read(id);
      if (saved === undefined) return true;
      const dataRoot = path.join(yield* fs.realPath(options.stateRoot), id, "data");
      if (saved.lifetime === "session")
        yield* destroyStack(state, saved, dataRoot, options.cacheRoot);
      else yield* Owner.sweepContainers(saved, dataRoot);
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
    readonly state: State.Interface;
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
  },
  Effect.catchCause((cause) => Effect.logWarning("Orphan sweep failed", cause)),
);
