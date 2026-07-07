import type { ServiceName } from "./versions.ts";

/**
 * Wrap a service-start function so concurrent callers for the same service
 * share a single in-flight start.
 *
 * On failure, the in-flight entry is cleared (not marked done) so the next
 * call retries from scratch. Successful starts are not cached permanently:
 * process-compose startService is idempotent for already-running services, and
 * rechecking lets a service that was later stopped be started by the next
 * proxied request.
 */
export const makeEnsureServiceMemo = (
  start: (name: ServiceName) => Promise<void>,
): ((name: ServiceName) => Promise<void>) => {
  const inFlight = new Map<ServiceName, Promise<void>>();
  return (name) => {
    const existing = inFlight.get(name);
    if (existing) return existing;
    const p = start(name).then(
      () => {
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
