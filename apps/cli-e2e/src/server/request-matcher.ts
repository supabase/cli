import type { FixtureEntry, FixtureStore } from "./fixture-loader.ts";
import { fixtureKey } from "./placeholder.ts";

/** Per-fixture-key sequence counters — reset between tests via resetCounters(). */
export type SequenceCounters = Map<string, number>;

type MatchResult =
  | { ok: true; entry: FixtureEntry }
  | { ok: false; status: 400 | 502; message: string };

/** Find the next unserved fixture entry for a given request and validate that
 *  the incoming query params (and body, if recorded) match the fixture.
 *
 *  Returns { ok: false, status: 400 } with a readable diff when the request
 *  does not match the fixture, so the replay server can surface a clear error
 *  rather than silently serving a wrong response. Returns { ok: false,
 *  status: 502 } when no fixture exists for the endpoint. */
export function matchFixture(
  store: FixtureStore,
  counters: SequenceCounters,
  method: string,
  urlPath: string,
  incoming: { query: Record<string, string>; body: unknown },
): MatchResult {
  const key = fixtureKey(method, urlPath);
  const entries = store.get(key);
  if (!entries || entries.length === 0) {
    return {
      ok: false,
      status: 502,
      message: `Missing fixture: ${describeRequest(method, urlPath)} — run with RECORD=true to record`,
    };
  }

  const index = counters.get(key) ?? 0;
  const entry = entries[index % entries.length];
  // Advance counter before validation — the request slot is consumed regardless.
  counters.set(key, index + 1);

  if (!entry) {
    return {
      ok: false,
      status: 502,
      message: `Fixture store error for ${describeRequest(method, urlPath)} — no entry at index ${(index % entries.length).toString()}`,
    };
  }

  const label = describeRequest(method, urlPath);

  const expectedQuery = entry.request.query;
  const actualQuery = incoming.query;
  if (JSON.stringify(expectedQuery) !== JSON.stringify(actualQuery)) {
    return {
      ok: false,
      status: 400,
      message: [
        `Request query mismatch for ${label}:`,
        `  expected: ${JSON.stringify(expectedQuery)}`,
        `  actual:   ${JSON.stringify(actualQuery)}`,
      ].join("\n"),
    };
  }

  // Only validate body when the fixture recorded a non-null body.
  if (entry.request.body !== null) {
    if (JSON.stringify(entry.request.body) !== JSON.stringify(incoming.body)) {
      return {
        ok: false,
        status: 400,
        message: [
          `Request body mismatch for ${label}:`,
          `  expected: ${JSON.stringify(entry.request.body)}`,
          `  actual:   ${JSON.stringify(incoming.body)}`,
        ].join("\n"),
      };
    }
  }

  return { ok: true, entry };
}

/** Reset sequence counters so tests start from the beginning of each fixture queue. */
export function resetCounters(counters: SequenceCounters): void {
  counters.clear();
}

/** Build a human-readable key string for error messages. */
function describeRequest(method: string, urlPath: string): string {
  return `${method.toUpperCase()} ${urlPath}`;
}
