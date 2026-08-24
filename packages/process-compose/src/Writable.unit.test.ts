import { EventEmitter } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { writeChunk } from "./Writable.ts";

class ControlledWritable extends EventEmitter {
  readonly writable = true;
  readonly writes: Array<string> = [];
  private blockNext = true;

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    if (this.blockNext) {
      this.blockNext = false;
      return false;
    }
    return true;
  }

  end(): this {
    return this;
  }
}

describe("writeChunk", () => {
  it.effect("waits for drain before writing the next stream chunk", () =>
    Effect.gen(function* () {
      const writable = new ControlledWritable();
      const fiber = yield* Effect.forkChild(
        Effect.forEach(
          [new TextEncoder().encode("first"), new TextEncoder().encode("second")],
          (chunk) => writeChunk(writable, chunk),
          { discard: true },
        ),
        { startImmediately: true },
      );

      yield* Effect.yieldNow;
      expect(writable.writes).toEqual(["first"]);
      writable.emit("drain");
      yield* Fiber.join(fiber);
      expect(writable.writes).toEqual(["first", "second"]);
    }),
  );

  it.effect("removes drain, error, and close listeners when cancelled", () =>
    Effect.gen(function* () {
      const writable = new ControlledWritable();
      const fiber = yield* Effect.forkChild(writeChunk(writable, new Uint8Array([1])), {
        startImmediately: true,
      });

      yield* Effect.yieldNow;
      expect(writable.listenerCount("drain")).toBe(1);
      expect(writable.listenerCount("error")).toBe(1);
      expect(writable.listenerCount("close")).toBe(1);

      yield* Fiber.interrupt(fiber);
      expect(writable.listenerCount("drain")).toBe(0);
      expect(writable.listenerCount("error")).toBe(0);
      expect(writable.listenerCount("close")).toBe(0);
    }),
  );
});
