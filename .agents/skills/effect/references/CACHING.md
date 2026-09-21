# Caching, Memoization, And Request Dedupe

Use this when memoizing expensive lookups, caching per-key results with TTL, deduplicating concurrent identical calls, or considering request batching.

Prefer `effect/Cache` over a `Map` + timestamp + prune-loop cache when its keyed memoization, TTL, capacity, lifecycle, and eviction semantics fit.

## Core Rules

- `Cache.make({ capacity, lookup, timeToLive })` caches per-key lookups with one fixed TTL for all entries.
- `Cache.makeWith(lookup, { capacity, timeToLive(exit, key) })` computes TTL per entry from the lookup's `Exit` — the tool for "cache successes, not failures".
- Concurrent `Cache.get` calls for the same missing key share one pending lookup — dedupe is built in; do not add your own in-flight tracking.
- `capacity` is required and bounds the cache; stop writing manual prune/evict loops.
- Return a zero TTL (`0` or `"0 millis"`) from `timeToLive` to avoid caching transient failures or degraded fallbacks without failing the caller. A short negative-cache TTL can be appropriate for stable failures such as not-found results.
- `Cache.invalidate(cache, key)` / `Cache.refresh(cache, key)` handle explicit staleness; `Cache.has` checks without triggering a lookup.
- Cache construction is effectful. Build the cache once in the owning layer/scope and share the handle; a cache built per call caches nothing.
- For a single value (no key), use `Effect.cached(effect)` or `Effect.cachedWithTTL(effect, ttl)` instead of a one-key Cache.
- For cached resources that need cleanup (connections, clients), use `ScopedCache`.

## Exit-Aware TTL (cache successes, skip degraded results)

```ts
import { Cache, Duration, Effect, Exit } from "effect";

const makeResolver = Effect.gen(function* () {
  const cache = yield* Cache.makeWith(
    (channelRef: string) => resolveUncached(channelRef), // never-failing, returns { where, cacheable }
    {
      capacity: 300,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.cacheable ? "10 minutes" : Duration.zero,
    },
  );
  return (channelRef: string) =>
    Cache.get(cache, channelRef).pipe(Effect.map((resolved) => resolved.where));
});
```

This replaces a hand-rolled `Map<string, { value, expiresAtMs }>` plus prune logic, and upgrades it: repeated rows pointing at the same key during one burst share a single provider call.

## Expensive Client Acquisition Belongs In The Layer, Not The Lookup

A cache cannot fix a lookup that pays a scoped acquisition per call, such as SDK client construction or authentication. Acquire clients once via the owning layer (`Layer.build` inside a `Layer.unwrap(Effect.gen(...))` composition, or a service dependency) so the cached lookup is a plain call:

```ts
// Bad: every cache miss acquires a fresh client
const lookup = (id: string) => getRecord(id).pipe(Effect.provide(apiClientLayer(options)));

// Good: client built once for the layer's lifetime; misses are one API call
// Layer.build requires Scope.Scope; acquire this inside the owning layer's scope.
const context = yield * Layer.build(apiClientLayer(options));
const lookup = (id: string) => Context.get(context, ApiClient).getRecord(id);
```

## Request Batching (`Effect.request` + `RequestResolver`)

Batching exists for backends with a real batch endpoint: the resolver receives an array of pending requests and can collapse them into one wire call.

- Use it when the API can answer N keys in one call (SQL `IN (...)`, DataLoader-style endpoints, batch GET).
- Do not reach for it when the backend only has per-item endpoints (most REST provider APIs): a batched resolver still loops one call per entry, so it buys nothing over `Effect.forEach(items, f, { concurrency })` plus `Cache` for dedupe/memoization.
- `RequestResolver.batchN(resolver, n)` bounds batch size; `RequestResolver.makeGrouped` groups requests that must resolve through different targets.

Selection guide:

- Same key requested repeatedly over time → `Cache`.
- Same key requested concurrently in one burst → `Cache` (shared pending lookup).
- Many distinct keys, backend has a batch endpoint → `Effect.request` + `RequestResolver`.
- Many distinct keys, per-item endpoint only → `Effect.forEach(..., { concurrency: n })`, optionally through a `Cache`.

## Do Nots

- Do not hand-roll Map/TTL/prune caches, in-flight dedupe maps, or LRU logic when `Cache` fits.
- Choose failure TTLs by semantics. Skip transient failures and degraded fallbacks by default; bounded negative caching can protect an upstream from repeated stable failures.
- Do not build a cache inside the request handler or per call — hoist it to the owning layer.
- Do not adopt `RequestResolver` batching for per-item REST endpoints just because "batching" sounds faster.
- Do not put scoped client acquisition inside the cache lookup; acquire once in the layer.
