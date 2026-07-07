import type { ServiceName } from "./versions.ts";

/**
 * Wrap a service-start function so concurrent callers for the same service
 * share a single in-flight start, and a completed start resolves immediately
 * on subsequent calls without re-invoking `start`.
 *
 * On failure, the in-flight entry is cleared (not marked done) so the next
 * call retries from scratch.
 */
export const makeEnsureServiceMemo = (
  start: (name: ServiceName) => Promise<void>,
): ((name: ServiceName) => Promise<void>) => {
  const inFlight = new Map<ServiceName, Promise<void>>();
  const done = new Set<ServiceName>();
  return (name) => {
    if (done.has(name)) return Promise.resolve();
    const existing = inFlight.get(name);
    if (existing) return existing;
    const p = start(name).then(
      () => {
        done.add(name);
        inFlight.delete(name);
      },
      (err: unknown) => {
        inFlight.delete(name);
        throw err;
      },
    );
    inFlight.set(name, p);
    return p;
  };
};
