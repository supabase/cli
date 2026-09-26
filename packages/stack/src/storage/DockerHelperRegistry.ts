import { Effect, Exit, Ref, Scope, Semaphore } from "effect";

export interface DockerHelperRegistry {
  /** Identifies helpers owned by one host process. */
  readonly ownerId: string;
  /** Runs `body` with the helper for `key`, opening it once per host lifetime. */
  readonly use: <A, E>(
    key: string,
    open: Effect.Effect<string, E>,
    close: (id: string) => Effect.Effect<void, E>,
    body: (id: string) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Forgets a dead helper so the next use starts another. */
  readonly drop: (key: string) => Effect.Effect<void>;
}

interface Helper {
  readonly id: string;
  /** Distinguishes reopened helpers, whose ids can repeat. */
  readonly generation: number;
  readonly close: (id: string) => Effect.Effect<void>;
}

/** Uses of one helper that may run at once; opening or closing it takes all of them. */
const concurrentUses = 1024;

/**
 * One sleeping container per volume mount. Mounts are fixed when the container is created,
 * and every database in a state directory uses that same volume. Uses of one helper run
 * concurrently; opening and closing it wait for them.
 */
export const makeDockerHelperRegistry = (
  ownerId: string,
): Effect.Effect<DockerHelperRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const helpers = yield* Ref.make(new Map<string, Helper>());
    const generations = yield* Ref.make(0);
    const gates = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
    const scope = yield* Scope.Scope;
    const gateFor = (key: string) =>
      Ref.modify(gates, (map) => {
        const existing = map.get(key);
        if (existing !== undefined) return [existing, map];
        const gate = Semaphore.makeUnsafe(concurrentUses);
        return [gate, new Map(map).set(key, gate)];
      });
    const exclusive = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
      gateFor(key).pipe(Effect.flatMap((gate) => gate.withPermits(concurrentUses)(effect)));
    // Only the helper a use saw is closed; a replacement opened since then stays.
    const forget = (key: string, generation?: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(helpers)).get(key);
        if (entry === undefined || (generation !== undefined && entry.generation !== generation))
          return;
        yield* Ref.update(helpers, (map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
        yield* entry.close(entry.id);
      });
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        for (const key of (yield* Ref.get(gates)).keys()) yield* exclusive(key, forget(key));
      }),
    );
    const openOnce = <E>(
      key: string,
      open: Effect.Effect<string, E>,
      close: (id: string) => Effect.Effect<void, E>,
    ) =>
      exclusive(
        key,
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(helpers)).has(key)) return;
            const id = yield* restore(open);
            const generation = yield* Ref.updateAndGet(generations, (value) => value + 1);
            yield* Ref.update(helpers, (map) =>
              new Map(map).set(key, {
                id,
                generation,
                close: (helperId) =>
                  close(helperId).pipe(Effect.catch((cause) => Effect.logError(cause))),
              }),
            );
          }),
        ),
      );
    const use = <A, E>(
      key: string,
      open: Effect.Effect<string, E>,
      close: (id: string) => Effect.Effect<void, E>,
      body: (id: string) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const gate = yield* gateFor(key);
          let helper: Helper | undefined;
          while (helper === undefined) {
            yield* restore(gate.take(1));
            helper = (yield* Ref.get(helpers)).get(key);
            if (helper !== undefined) break;
            yield* gate.release(1);
            yield* restore(openOnce(key, open, close));
          }
          const exit = yield* Effect.exit(restore(body(helper.id)));
          yield* gate.release(1);
          // An interrupted exec can leave its command running inside the helper, so the
          // helper is closed once its other uses finish.
          if (Exit.hasInterrupts(exit)) yield* exclusive(key, forget(key, helper.generation));
          return yield* exit;
        }),
      );
    const drop = (key: string): Effect.Effect<void> => exclusive(key, forget(key));
    return { ownerId, use, drop };
  });
