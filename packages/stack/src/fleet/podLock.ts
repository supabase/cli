/**
 * Per-key async operation lock: serializes `withLock` calls that share the
 * same `id` onto a single chain, while calls for different ids run fully
 * concurrently.
 *
 * Used by `Fleet` to make sure a pod's lifecycle operations (wake, suspend,
 * destroy, reset, fork) never interleave against the same pod's data
 * directory / postgres process — e.g. a wake racing an in-flight suspend
 * could otherwise `createStack` against a data dir whose postmaster is
 * still shutting down.
 */
export class PodLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Number of ids currently holding a live (unsettled) chain entry. */
  get size(): number {
    return this.chains.size;
  }

  /**
   * Runs `fn` after every previously chained op for `id` has settled
   * (resolved OR rejected), and returns `fn`'s result/rejection.
   *
   * A rejection from `fn` (or from an earlier op in the chain) never
   * poisons subsequent calls for the same `id` — the chain always advances
   * to a resolved "tail" internally, regardless of whether the caller-visible
   * promise for a given link rejects.
   */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve();

    // The tail settles once `prior` has settled, regardless of outcome, so
    // the next `withLock` call for this id always proceeds.
    const tail = prior.then(
      () => undefined,
      () => undefined,
    );
    const result = tail.then(fn);

    // Keep the chain alive (swallow rejection here too) so the *next* link
    // waits for this one without itself becoming a rejected chain entry.
    const nextTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(id, nextTail);

    // Once this op's link is the most recent one recorded and it has
    // settled, clear the entry so the map doesn't grow unboundedly for pods
    // that are no longer being operated on.
    void nextTail.then(() => {
      if (this.chains.get(id) === nextTail) this.chains.delete(id);
    });

    return result;
  }
}
