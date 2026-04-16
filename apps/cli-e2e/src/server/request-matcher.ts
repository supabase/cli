import type { FixtureEntry, FixtureStore } from "./fixture-loader.ts";
import { fixtureKey } from "./placeholder.ts";

/** Per-fixture-key sequence counters — reset between tests via clearRequests(). */
export type SequenceCounters = Map<string, number>;

/** Find the next unserved fixture entry for a given request.
 *  Uses a sequence counter so repeated calls to the same endpoint
 *  return entries in recording order. */
export function matchFixture(
  store: FixtureStore,
  counters: SequenceCounters,
  method: string,
  urlPath: string,
): FixtureEntry | undefined {
  const key = fixtureKey(method, urlPath);
  const entries = store.get(key);
  if (!entries || entries.length === 0) return undefined;

  const index = counters.get(key) ?? 0;
  const entry = entries[index % entries.length];
  counters.set(key, index + 1);
  return entry;
}

/** Reset sequence counters so tests start from the beginning of each fixture queue. */
export function resetCounters(counters: SequenceCounters): void {
  counters.clear();
}

/** Build a human-readable key string for error messages. */
export function describeRequest(method: string, urlPath: string): string {
  return `${method.toUpperCase()} ${urlPath}`;
}
