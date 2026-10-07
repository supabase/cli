import { Context, DateTime, Effect, FileSystem, Layer, Path } from "effect";
import { sweepTimeout } from "./HostProcess.ts";
import { isStackId } from "./identity/StackId.ts";
import * as Owner from "./Owner.ts";
import * as Container from "./runtime/Container.ts";
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
 * containers, only those on `engine` once the stack is no longer registered, and destroys the
 * stack when its lifetime is `session`. Returns `held` when another process holds the lease,
 * `registered` when, with `engine`, the stack is registered again, and otherwise `reclaimed`.
 */
export const reclaimStack = Effect.fn("Sweep.reclaimStack")(function* (options: {
  readonly state: State.Interface;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly id: string;
  readonly engine?: "docker" | "podman";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { state, id } = options;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      if (!(yield* state.lease(id))) return "held";
      yield* Effect.addFinalizer(() => state.retractHolder(id).pipe(Effect.ignore));
      yield* state.publishHolder(id, {
        role: "sweeper",
        pid: process.pid,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      const saved = yield* state.read(id);
      if (options.engine !== undefined && saved !== undefined) return "registered";
      const stack =
        saved ?? (options.engine === undefined ? undefined : { id, runtime: options.engine });
      if (stack === undefined) return "reclaimed";
      const dataRoot = path.join(yield* fs.realPath(options.stateRoot), id, "data");
      yield* Owner.sweepContainers(stack, dataRoot);
      if (saved === undefined) return "reclaimed";
      // Reading drops saved Vector instances, so destroying does not depend on the migration.
      yield* state
        .migrate(id)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Unable to migrate the saved state of stack ${id}`, error),
          ),
        );
      if (saved.lifetime === "session")
        yield* destroyStack(state, saved, dataRoot, options.cacheRoot);
      return "reclaimed";
    }),
  ).pipe(Effect.timeout(sweepTimeout));
});

/**
 * Keeps stack-labelled containers and session stacks alive only while their lease is held: every
 * other stack of this state root whose lease is free is reclaimed, including a deleted stack whose
 * containers remain on an engine the root's stacks use.
 */
export const sweepOrphans = Effect.fn("Sweep.orphans")(
  function* (options: {
    readonly state: State.Interface;
    readonly stateRoot: string;
    readonly cacheRoot: string;
    readonly ownerId: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reclaim = (id: string, engine?: "docker" | "podman") =>
      reclaimStack({ ...options, id, engine }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Orphan sweep of stack ${id} failed`, cause),
        ),
      );
    const stacks = yield* options.state.list;
    for (const { id } of stacks) if (id !== options.ownerId) yield* reclaim(id);
    const registered = new Set(stacks.map(({ id }) => id));
    const stateRoot = yield* fs.realPath(options.stateRoot);
    const engines = new Set(
      stacks.flatMap(({ runtime }) => (runtime === "native" ? [] : [runtime])),
    );
    for (const engine of engines) {
      const containers = yield* Container.listStackContainers(engine).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Orphan sweep of ${engine} containers failed`, error).pipe(
            Effect.as([]),
          ),
        ),
      );
      const deleted = containers
        .filter(
          ({ stackId, root }) =>
            isStackId(stackId) &&
            !registered.has(stackId) &&
            root === path.join(stateRoot, stackId, "data"),
        )
        .map(({ stackId }) => stackId);
      for (const id of new Set(deleted)) yield* reclaim(id, engine);
    }
  },
  Effect.catchCause((cause) => Effect.logWarning("Orphan sweep failed", cause)),
);
