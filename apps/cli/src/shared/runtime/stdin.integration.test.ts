import { describe, expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Option, Queue, Stdio, Stream } from "effect";
import { TestClock } from "effect/testing";

import { mockTty } from "../../../tests/helpers/mocks.ts";
import { Stdin } from "./stdin.service.ts";
import { stdinLayer } from "./stdin.layer.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Exercises the real `stdinLayer` (its persistent, lazily-opened line reader) over a
// controllable `Stdio` stream, instead of the array-indexing `mockStdin` double.
// `Stdio.layerTest` lets us drive stdin as a byte Stream with deliberate chunking /
// delays; `stdinLayer` also needs `Tty`, satisfied by `mockTty`.
const withStdin = (stdin: Stream.Stream<Uint8Array>, stdinIsTty = false) =>
  stdinLayer.pipe(
    Layer.provide(Stdio.layerTest({ stdin })),
    Layer.provide(mockTty({ stdinIsTty, stdoutIsTty: false })),
  );

describe("stdinLayer readLine", () => {
  it.live("dispenses successive lines across calls, buffering multi-line chunks", () => {
    // Two chunks; the second carries two lines. A persistent reader must return a, b,
    // c across successive calls (the second call pulls a fresh chunk, the third is
    // served from the buffered remainder) — one bufio.Scanner, not a fresh read each
    // time. A final call on the exhausted stream yields None (the prompt default).
    const layer = withStdin(Stream.fromIterable([enc("a\n"), enc("b\nc\n")]));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("a"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("b"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("c"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves interior blank lines so answers stay aligned", () => {
    // splitLines keeps blank interior lines: a caller that pipes "\ny\n" sees the
    // blank line first (→ prompt default) and the y second, not y first.
    const layer = withStdin(Stream.fromIterable([enc("\ny\n")]));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some(""));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("y"));
    }).pipe(Effect.provide(layer));
  });

  it.live("times out to None when no line arrives within the window", () => {
    // A pipe that stays open without a newline (Go's non-TTY `ReadLine` timeout,
    // console.go:36): readLine must give up with None so the prompt takes its default
    // instead of blocking on EOF.
    const layer = withStdin(Stream.never);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(100)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps a piped stdin consumed once the reader is open", () =>
    Effect.gen(function* () {
      const pipe = yield* Queue.unbounded<Uint8Array>();
      const taken = yield* Deferred.make<boolean>();
      const layer = withStdin(
        Stream.fromQueue(pipe).pipe(
          Stream.tap((chunk) =>
            dec(chunk) === "b\n" ? Deferred.succeed(taken, true) : Effect.succeed(false),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        yield* Queue.offer(pipe, enc("a\n"));
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("a"));

        yield* Queue.offer(pipe, enc("b\n"));
        yield* Deferred.await(taken);

        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("b"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("answers prompts from the earliest lines when a producer floods the pipe", () => {
    const flood = Array.from({ length: 5_000 }, (_, index) => enc(`line-${index}\n`));
    const layer = withStdin(Stream.fromIterable(flood).pipe(Stream.concat(Stream.never)));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("line-0"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("line-1"));
    }).pipe(Effect.provide(layer));
  });

  it.live("dispenses successive lines on a TTY, which is read only when prompted", () => {
    const layer = withStdin(Stream.fromIterable([enc("a\n"), enc("b\nc\n")]), true);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("a"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("b"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("c"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.effect("times out to None on a TTY when the user does not answer in time", () => {
    const layer = withStdin(Stream.never, true);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      const reading = yield* Effect.forkChild(stdin.readLine(100));
      yield* TestClock.adjust(Duration.millis(100));
      expect(yield* Fiber.join(reading)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });
});
