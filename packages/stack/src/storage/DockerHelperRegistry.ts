import { Effect, Ref, Scope, Semaphore } from "effect";

interface DockerHelperHandle {
  readonly id: string;
  /** False when this process found a helper another process already created. */
  readonly created: boolean;
}

export interface DockerHelperRegistry {
  /** Identifies helpers owned by one host process. */
  readonly ownerId: string;
  /** Runs `body` with the helper for `key`, opening it once per host lifetime. */
  readonly use: <A, E>(
    key: string,
    open: Effect.Effect<DockerHelperHandle, E>,
    close: (id: string) => Effect.Effect<void, E>,
    body: (id: string) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Forgets a dead helper so the next use starts another. */
  readonly drop: (key: string) => Effect.Effect<void>;
}

/**
 * One sleeping container per volume mount. Mounts are fixed when the container is created,
 * and every database in a state directory uses that same volume.
 */
export const makeDockerHelperRegistry = (
  ownerId: string,
): Effect.Effect<DockerHelperRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const helpers = yield* Ref.make(
      new Map<
        string,
        { readonly id: string; readonly close: (id: string) => Effect.Effect<void> }
      >(),
    );
    const gate = yield* Semaphore.make(1);
    const scope = yield* Scope.Scope;
    const release = (id: string, close: (id: string) => Effect.Effect<void>) => close(id);
    yield* Scope.addFinalizer(
      scope,
      gate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.getAndSet(helpers, new Map());
          for (const entry of current.values()) yield* release(entry.id, entry.close);
        }),
      ),
    );
    const use = <A, E>(
      key: string,
      open: Effect.Effect<DockerHelperHandle, E>,
      close: (id: string) => Effect.Effect<void, E>,
      body: (id: string) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      gate.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(helpers);
          const existing = current.get(key);
          const id =
            existing?.id ??
            (yield* open.pipe(
              Effect.tap((opened) =>
                Ref.update(helpers, (map) => {
                  const next = new Map(map);
                  next.set(key, {
                    id: opened.id,
                    close: (helperId) =>
                      (opened.created ? close(helperId) : Effect.void).pipe(
                        Effect.catch((cause) => Effect.logError(cause)),
                      ),
                  });
                  return next;
                }),
              ),
              Effect.map((opened) => opened.id),
            ));
          return yield* body(id);
        }),
      );
    const drop = (key: string): Effect.Effect<void> =>
      gate.withPermit(
        Effect.gen(function* () {
          const entry = (yield* Ref.get(helpers)).get(key);
          if (entry === undefined) return;
          yield* Ref.update(helpers, (map) => {
            const next = new Map(map);
            next.delete(key);
            return next;
          });
          yield* release(entry.id, entry.close);
        }),
      );
    return { ownerId, use, drop };
  });
