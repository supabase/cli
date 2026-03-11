import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio, Stream } from "effect";
import { mockTty } from "../../tests/helpers/mocks.ts";
import { Stdin } from "./stdin.service.ts";
import { stdinLayer } from "./stdin.layer.ts";

const encoder = new TextEncoder();

function makeStdioLayer(stdin: Stream.Stream<Uint8Array>) {
  return Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin,
      stdout: { stream: Stream.empty, sink: { stream: Stream.empty } } as any,
      stderr: { stream: Stream.empty, sink: { stream: Stream.empty } } as any,
    }),
  );
}

describe("Stdin", () => {
  describe("isTTY", () => {
    it.effect("returns true when Tty.stdinIsTty is true", () => {
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(Stream.empty), mockTty({ stdinIsTty: true }))),
      );
      return Effect.gen(function* () {
        const { isTTY } = yield* Stdin;
        expect(isTTY).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns false when Tty.stdinIsTty is false", () => {
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(Stream.empty), mockTty({ stdinIsTty: false }))),
      );
      return Effect.gen(function* () {
        const { isTTY } = yield* Stdin;
        expect(isTTY).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("readPipedToken", () => {
    it.effect("returns Some(trimmed) for valid input", () => {
      const stdin = Stream.fromIterable([encoder.encode("  my-token-123  \n")]);
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(stdin), mockTty({ stdinIsTty: false }))),
      );
      return Effect.gen(function* () {
        const { readPipedToken } = yield* Stdin;
        const result = yield* readPipedToken;
        expect(result).toEqual(Option.some("my-token-123"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None for empty stream", () => {
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(Stream.empty), mockTty({ stdinIsTty: false }))),
      );
      return Effect.gen(function* () {
        const { readPipedToken } = yield* Stdin;
        const result = yield* readPipedToken;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None on stream error", () => {
      const stdin = Stream.fail(new Error("read error")) as unknown as Stream.Stream<Uint8Array>;
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(stdin), mockTty({ stdinIsTty: false }))),
      );
      return Effect.gen(function* () {
        const { readPipedToken } = yield* Stdin;
        const result = yield* readPipedToken;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });

    it.effect("handles multi-chunk input", () => {
      const stdin = Stream.fromIterable([
        encoder.encode("chunk1"),
        encoder.encode("-chunk2"),
        encoder.encode("-chunk3"),
      ]);
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(stdin), mockTty({ stdinIsTty: false }))),
      );
      return Effect.gen(function* () {
        const { readPipedToken } = yield* Stdin;
        const result = yield* readPipedToken;
        expect(result).toEqual(Option.some("chunk1-chunk2-chunk3"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None for whitespace-only input", () => {
      const stdin = Stream.fromIterable([encoder.encode("   \n  \t  ")]);
      const layer = stdinLayer.pipe(
        Layer.provide(Layer.mergeAll(makeStdioLayer(stdin), mockTty({ stdinIsTty: false }))),
      );
      return Effect.gen(function* () {
        const { readPipedToken } = yield* Stdin;
        const result = yield* readPipedToken;
        expect(result).toEqual(Option.none());
      }).pipe(Effect.provide(layer));
    });
  });
});
