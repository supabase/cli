# Streams

Use this when working with `Stream`, event sources, async iterables, queue/pubsub-backed streams, pagination, backpressure, throttling, debouncing, or long-lived stream consumers.

## Mental Model

`Stream<A, E, R>` is an effectful source that can emit many `A` values over time, fail with `E`, and require services `R`. Streams are pull-based and backpressured; consumption controls demand.

Use streams for sources that are naturally many-valued and time-ordered:

- gateway events
- provider callbacks adapted through queues
- subscription/event logs
- paginated APIs
- file/stdin/platform streams
- scheduled ticks when values matter
- pipelines with filtering, mapping, buffering, throttling, or bounded concurrent processing

Do not use streams just to loop forever. For one repeated effect with no emitted values, use `Effect.repeat(...)` with `Schedule`; read `SCHEDULING.md`.

## Source Chooser

- In-memory values: `Stream.make(...)` or `Stream.fromIterable(...)`.
- Test fixtures: `Stream.fromIterable(...)`, often with `Stream.concat(Stream.never)` for an open subscription.
- Queue-backed callback boundary: `Queue` plus `Stream.fromQueue(...)`.
- Broadcast events: `PubSub` plus `Stream.fromPubSub(...)`.
- Latest-value state plus updates: `SubscriptionRef`.
- Schedule-generated ticks/values: `Stream.fromSchedule(...)`.
- Paginated pull APIs: `Stream.paginate(...)`; its effectful step returns `Effect<readonly [ReadonlyArray<A>, Option<S>], E, R>`. The stream emits `A` elements, not page arrays. `Option.none()` ends pagination after emitting that step's elements; empty arrays are allowed.
- Async iterable/platform source: `Stream.fromAsyncIterable(...)` when no native Effect source exists.
- Effect that produces a stream after reading services/config: `Stream.unwrap(...)`.

## Transformation Chooser

- Pure transformation: `Stream.map(...)`.
- Effectful transformation: `Stream.mapEffect(...)`.
- Bounded concurrent effectful transformation: `Stream.mapEffect(fn, { concurrency })`.
- Drop ordering when order is irrelevant and latency matters: `Stream.mapEffect(fn, { concurrency, unordered: true })`.
- One input to zero/many outputs: `Stream.flatMap(...)`.
- Multiple inner streams concurrently: `Stream.flatMap(fn, { concurrency })`.
- Keep only matching values: `Stream.filter(...)` / `Stream.filterEffect(...)`.
- Stateful transformation: `Stream.mapAccum(...)` / `Stream.mapAccumEffect(...)`.

## Consumption Chooser

- Side-effecting consumer: `Stream.runForEach(...)`.
- Ignore elements but run the stream: `Stream.runDrain`.
- Tests/small finite streams: `Stream.runCollect`.
- First N values in tests: `Stream.take(n)` plus `Stream.runCollect`.
- Fold into a value: `Stream.runFold(...)`.
- Long-lived consumer in a layer: `stream.pipe(Stream.runForEach(...), Effect.forkScoped)`.

Avoid `Stream.runCollect` on unbounded or production event streams.

## Long-Lived Consumers

Own long-lived stream consumers in layers and fork them into the layer scope.

```ts
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* Gateway.Service;

    yield* gateway.events.pipe(
      Stream.filter(isMessageEvent),
      Stream.runForEach(handleEvent),
      Effect.forkScoped,
    );
  }),
);
```

Guidance:

- Let the layer own the stream lifetime.
- Use `Effect.forkScoped` for the ordinary case.
- If methods need to fork work into the layer lifetime, capture `Scope.Scope` during layer acquisition and use `Effect.forkIn(scope)` internally. Do not expose the scope as public service API.
- Preserve stream failures unless the owning boundary has a truthful recovery policy.

## Queues, PubSub, And SubscriptionRef

- Use `Queue` when each event/item should be consumed by one consumer or worker.
- Use `PubSub` when every subscriber should see every event.
- Use `SubscriptionRef` when consumers need the current value and a stream of changes.
- Expose a `Stream` from service interfaces when callers should consume events, not push into the queue.
- Keep producer queues/private refs inside the implementation or test service.

Good service shape:

```ts
export interface Interface {
  readonly events: Stream.Stream<ProviderEvent, ProviderError>;
  readonly status: Stream.Stream<ProviderStatus>;
}
```

Implementation can use private `Queue` / `SubscriptionRef`; consumers see streams.

## Backpressure And Buffers

Prefer natural stream backpressure first.

Use `Stream.buffer(...)` only when producer and consumer should decouple.

- `strategy: "suspend"`: apply backpressure when full.
- `strategy: "dropping"`: drop new values when full.
- `strategy: "sliding"`: keep the latest values by dropping old ones.
- `capacity: "unbounded"`: rare; use only when growth is bounded elsewhere.

Use `Stream.debounce(...)` for quiet-period behavior and `Stream.throttle(...)` / `Stream.throttleEffect(...)` for rate-shaped streams.

## Error Handling

- Prefer typed stream errors over defects.
- Use `Stream.mapError(...)` to translate errors at boundaries.
- Use `Stream.catchIf(...)`, `Stream.catchTag(...)`, or `Stream.catchFilter(...)` for typed recovery.
- Use `Stream.catchCause(...)` only at explicit supervision boundaries.
- Do not hide stream defects by default; let them reach the owning layer/runtime unless the stream is explicitly best-effort.

## Keyed Concurrency

For streams of work keyed by session/channel/id, prefer a named helper over ad hoc maps of fibers.

If the codebase already has a keyed-run helper (for example a `runForEachKeyed` that runs different keys concurrently while serializing each key and coalescing pending values into one latest-value rerun), use it. Otherwise build one named helper with `FiberMap` rather than scattering fiber bookkeeping through consumers.

Use this for projection/reconciliation streams where each key needs ordered processing but different keys can run in parallel.

## Tests

- Use `Stream.fromIterable(...)` for finite fixtures.
- Use `Stream.empty` for no events.
- Use `Stream.fromQueue(...)` with a test-owned `Queue` when the test needs to drive events interactively.
- Use `Stream.take(n)` plus `Stream.runCollect` for finite assertions.
- Avoid real sleeps; coordinate with `Deferred`, `Queue`, `Latch`, and `TestClock`.
