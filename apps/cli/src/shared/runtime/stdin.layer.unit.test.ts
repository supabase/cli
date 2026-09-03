import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
import { mockTty } from "../../../tests/helpers/mocks.ts";
import { Stdin } from "./stdin.service.ts";
import { stdinLayerFrom } from "./stdin.layer.ts";

const encoder = new TextEncoder();

const readError = Stream.fail(
  systemError({
    module: "Stdin",
    method: "read",
    _tag: "Unknown",
    description: "EAGAIN: resource temporarily unavailable, read",
    cause: new Error("EAGAIN: resource temporarily unavailable, read"),
  }),
);

const withStdin = (stdin: Stream.Stream<Uint8Array, PlatformError>, stdinIsTty = false) =>
  stdinLayerFrom(stdin).pipe(Layer.provide(mockTty({ stdinIsTty })));

describe("Stdin", () => {
  describe("isTTY", () => {
    it.effect("returns true when Tty.stdinIsTty is true", () => {
      const layer = withStdin(Stream.empty, true);
      return Effect.gen(function* () {
        const { isTTY } = yield* Stdin;
        expect(isTTY).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns false when Tty.stdinIsTty is false", () => {
      const layer = withStdin(Stream.empty);
      return Effect.gen(function* () {
        const { isTTY } = yield* Stdin;
        expect(isTTY).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("readPipedBytes", () => {
    it.effect("returns Some(bytes) for valid input", () => {
      const expected = encoder.encode("  my-token-123  \n");
      const stdin = Stream.fromIterable([expected]);
      const layer = withStdin(stdin);
      return Effect.gen(function* () {
        const { readPipedBytes } = yield* Stdin;
        const result = yield* readPipedBytes;
        expect(result).toEqual(Option.some(expected));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None for empty stream", () => {
      const layer = withStdin(Stream.empty);
      return Effect.gen(function* () {
        const { readPipedBytes } = yield* Stdin;
        const result = yield* readPipedBytes;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None on stream error", () => {
      const layer = withStdin(readError);
      return Effect.gen(function* () {
        const { readPipedBytes } = yield* Stdin;
        const result = yield* readPipedBytes;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("handles multi-chunk input", () => {
      const expected = encoder.encode("chunk1-chunk2-chunk3");
      const stdin = Stream.fromIterable([
        encoder.encode("chunk1"),
        encoder.encode("-chunk2"),
        encoder.encode("-chunk3"),
      ]);
      const layer = withStdin(stdin);
      return Effect.gen(function* () {
        const { readPipedBytes } = yield* Stdin;
        const result = yield* readPipedBytes;
        expect(result).toEqual(Option.some(expected));
      }).pipe(Effect.provide(layer));
    });

    it.effect("preserves whitespace-only input", () => {
      const expected = encoder.encode("   \n  \t  ");
      const stdin = Stream.fromIterable([expected]);
      const layer = withStdin(stdin);
      return Effect.gen(function* () {
        const { readPipedBytes } = yield* Stdin;
        const result = yield* readPipedBytes;
        expect(result).toEqual(Option.some(expected));
      }).pipe(Effect.provide(layer));
    });
  });

  describe("readPipedText", () => {
    it.effect("returns Some(trimmed) for valid input", () => {
      const stdin = Stream.fromIterable([encoder.encode("  my-token-123  \n")]);
      const layer = withStdin(stdin);
      return Effect.gen(function* () {
        const { readPipedText } = yield* Stdin;
        const result = yield* readPipedText;
        expect(result).toEqual(Option.some("my-token-123"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None for empty stream", () => {
      const layer = withStdin(Stream.empty);
      return Effect.gen(function* () {
        const { readPipedText } = yield* Stdin;
        const result = yield* readPipedText;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None on stream error", () => {
      const layer = withStdin(readError);
      return Effect.gen(function* () {
        const { readPipedText } = yield* Stdin;
        const result = yield* readPipedText;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("handles multi-chunk input", () => {
      const stdin = Stream.fromIterable([
        encoder.encode("chunk1"),
        encoder.encode("-chunk2"),
        encoder.encode("-chunk3"),
      ]);
      const layer = withStdin(stdin);
      return Effect.gen(function* () {
        const { readPipedText } = yield* Stdin;
        const result = yield* readPipedText;
        expect(result).toEqual(Option.some("chunk1-chunk2-chunk3"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None for whitespace-only input", () => {
      const stdin = Stream.fromIterable([encoder.encode("   \n  \t  ")]);
      const layer = withStdin(stdin);
      return Effect.gen(function* () {
        const { readPipedText } = yield* Stdin;
        const result = yield* readPipedText;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });
  });

  describe("readLine", () => {
    it.effect("returns None at EOF", () => {
      const layer = withStdin(Stream.empty);
      return Effect.gen(function* () {
        const { readLine } = yield* Stdin;
        const result = yield* readLine(10_000);
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None on a read error, for every prompt", () => {
      const layer = withStdin(readError);
      return Effect.gen(function* () {
        const { readLine } = yield* Stdin;
        const first = yield* readLine(10_000);
        const second = yield* readLine(10_000);
        expect(first).toEqual(Option.none());
        expect(second).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("propagates a defect instead of answering the prompt", () => {
      const layer = withStdin(Stream.die(new Error("boom")));
      return Effect.gen(function* () {
        const { readLine } = yield* Stdin;
        const exit = yield* readLine(10_000).pipe(Effect.exit);
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });
});
