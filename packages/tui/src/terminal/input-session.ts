import { Effect, Exit, FiberHandle, PubSub, Scope, Semaphore, Stream } from "effect";

import * as Decoder from "./decoder.ts";
import { Key } from "./key.ts";

/** The slice of a readable TTY stream the input session drives; `process.stdin` satisfies it. */
export interface InputStream {
  readonly isTTY?: boolean | undefined;
  readonly isRaw?: boolean | undefined;
  readonly readableEnded?: boolean | undefined;
  /** Node's flow state: `true` when something already consumes the stream. */
  readonly readableFlowing?: boolean | null | undefined;
  readonly setRawMode?: ((mode: boolean) => unknown) | undefined;
  resume(): unknown;
  pause(): unknown;
  on(event: "data" | "end" | "error", listener: (chunk: Uint8Array | string) => void): unknown;
  off(event: "data" | "end" | "error", listener: (chunk: Uint8Array | string) => void): unknown;
}

/** One run's claim on stdin: decoded keys while open, nothing after `close`. */
export interface InputSession {
  /** Shared decoder output; the first active stream acquires stdin, the last to end releases it. */
  readonly keys: Stream.Stream<Key>;
  /** Calls `listener` for each decoded key as the decoder produces it, before any `keys` stream sees it. */
  readonly observe: (listener: (key: Key) => void) => Effect.Effect<void>;
  /** Closes the session and force-releases stdin; later `keys` streams are empty. */
  readonly close: Effect.Effect<void>;
}

const escapeTimeout = "50 millis";
const encoder = new TextEncoder();

interface Acquisition {
  readonly pubsub: PubSub.PubSub<Key>;
  readonly scope: Scope.Closeable;
  readonly detach: Effect.Effect<void>;
  /** Delivers the end of an input stream that had already ended when it was acquired. */
  readonly deliverEarlyEnd: (() => void) | undefined;
}

const acquire = Effect.fn("Terminal.input.acquire")(function* (
  input: InputStream,
  observers: ReadonlySet<(key: Key) => void>,
) {
  const pubsub = yield* PubSub.unbounded<Key>();
  const scope = yield* Scope.make();
  const runTimer = yield* FiberHandle.makeRuntime<never>().pipe(Scope.provide(scope));

  let decoder = Decoder.initialState;
  let generation = 0;
  const publish = (keys: ReadonlyArray<Key>) => {
    for (const key of keys) {
      for (const observer of observers) observer(key);
      PubSub.publishUnsafe(pubsub, key);
    }
  };
  const flush = () => {
    const flushed = Decoder.flushEscape(decoder);
    decoder = flushed.state;
    return flushed.keys;
  };

  const onData = (chunk: Uint8Array | string) => {
    const result = Decoder.feed(decoder, typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    decoder = result.state;
    publish(result.keys);
    const armed = ++generation;
    if (!Decoder.hasPendingEscape(decoder)) return;
    runTimer(
      Effect.sleep(escapeTimeout).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (generation === armed) publish(flush());
          }),
        ),
      ),
    );
  };
  const onEnd = () => {
    generation++;
    publish([...flush(), Key.Eof()]);
  };

  const rawControlled = input.isTTY === true && input.setRawMode !== undefined;
  const priorRaw = input.isRaw === true;
  // Attaching a `data` listener starts the flow, so this has to be read first.
  const wasFlowing = input.readableFlowing === true;
  if (rawControlled) input.setRawMode?.(true);
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onEnd);
  input.resume();

  // Each step guards its own failure so a hung-up terminal cannot skip the rest of the release.
  const step = (run: () => unknown) => Effect.try(run).pipe(Effect.ignore);
  const detach = Effect.gen(function* () {
    yield* step(() => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
    });
    if (!wasFlowing) yield* step(() => input.pause());
    if (rawControlled) yield* step(() => input.setRawMode?.(priorRaw));
  });

  // Node emitted `end` before anyone listened, so a live listener would wait forever.
  const deliverEarlyEnd = input.readableEnded === true ? onEnd : undefined;

  return { pubsub, scope, detach, deliverEarlyEnd } satisfies Acquisition;
});

const release = Effect.fn("Terminal.input.release")(function* (acquisition: Acquisition) {
  yield* acquisition.detach;
  yield* PubSub.shutdown(acquisition.pubsub);
  yield* Scope.close(acquisition.scope, Exit.void);
});

/** Opens the single input session for a run; closing the surrounding scope closes the session. */
export const openInputSession = Effect.fn("Terminal.openInput")(function* (input: InputStream) {
  const lock = Semaphore.makeUnsafe(1);
  const observers = new Set<(key: Key) => void>();
  let closed = false;
  let active: Acquisition | undefined;
  let references = 0;

  const attach = Effect.acquireRelease(
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (closed) return undefined;
        const fresh = active === undefined;
        active ??= yield* acquire(input, observers);
        references++;
        const subscription = yield* PubSub.subscribe(active.pubsub);
        if (fresh) active.deliverEarlyEnd?.();
        return { acquisition: active, subscription };
      }),
    ),
    (attached) =>
      attached === undefined
        ? Effect.void
        : lock.withPermits(1)(
            Effect.gen(function* () {
              if (active !== attached.acquisition || --references > 0) return;
              active = undefined;
              yield* release(attached.acquisition);
            }),
          ),
  );

  const keys = Stream.unwrap(
    Effect.map(attach, (attached) =>
      attached === undefined
        ? Stream.empty
        : Stream.fromSubscription(attached.subscription).pipe(Stream.takeUntil(Key.guards.Eof)),
    ),
  );

  const observe = (listener: (key: Key) => void) =>
    Effect.sync(() => {
      observers.add(listener);
    });

  const close = lock
    .withPermits(1)(
      Effect.gen(function* () {
        closed = true;
        const current = active;
        active = undefined;
        references = 0;
        if (current !== undefined) yield* release(current);
      }),
    )
    .pipe(Effect.uninterruptible);

  yield* Effect.addFinalizer(() => close);
  return { keys, observe, close } satisfies InputSession;
});
