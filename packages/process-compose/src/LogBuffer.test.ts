import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { LogBuffer } from "./LogBuffer.ts";

const layer = LogBuffer.layer;

describe("LogBuffer", () => {
  it.live("appends and retrieves history", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;
      yield* log.append("svc", "stdout", "line1");
      yield* log.append("svc", "stdout", "line2");
      yield* log.append("svc", "stderr", "line3");
      const entries = yield* log.history("svc");
      expect(entries).toHaveLength(3);
      expect(entries[0]?.line).toBe("line1");
      expect(entries[1]?.line).toBe("line2");
      expect(entries[2]?.line).toBe("line3");
    }).pipe(Effect.provide(layer)),
  );

  it.live("history respects limit", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;
      for (let i = 0; i < 10; i++) {
        yield* log.append("svc", "stdout", `line${i}`);
      }
      const entries = yield* log.history("svc", 3);
      expect(entries).toHaveLength(3);
      expect(entries[0]?.line).toBe("line7");
      expect(entries[1]?.line).toBe("line8");
      expect(entries[2]?.line).toBe("line9");
    }).pipe(Effect.provide(layer)),
  );

  it.live("subscribe receives live entries", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;

      // Start collecting 1 entry from the subscription in background
      const collectEffect = log.subscribe("svc").pipe(Stream.take(1), Stream.runCollect);
      const fiber = yield* Effect.forkChild(collectEffect);

      // Give the subscriber a moment to be registered
      yield* Effect.yieldNow;

      yield* log.append("svc", "stdout", "hello");

      const entries = yield* Fiber.join(fiber);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.line).toBe("hello");
      expect(entries[0]?.service).toBe("svc");
      expect(entries[0]?.stream).toBe("stdout");
    }).pipe(Effect.provide(layer)),
  );

  it.live("ring buffer eviction keeps only MAX_BUFFER_SIZE entries", () => {
    const MAX_BUFFER_SIZE = 10_000;
    return Effect.gen(function* () {
      const log = yield* LogBuffer;
      const total = MAX_BUFFER_SIZE + 100;
      for (let i = 0; i < total; i++) {
        yield* log.append("svc", "stdout", `line${i}`);
      }
      const entries = yield* log.history("svc", MAX_BUFFER_SIZE + 100);
      expect(entries).toHaveLength(MAX_BUFFER_SIZE);
      // First entry should be line100 (earliest 100 entries were evicted)
      expect(entries[0]?.line).toBe("line100");
    }).pipe(Effect.provide(layer));
  });

  it.live("truncate clears buffer", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;
      yield* log.append("svc", "stdout", "line1");
      yield* log.append("svc", "stdout", "line2");
      yield* log.truncate("svc");
      const entries = yield* log.history("svc");
      expect(entries).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("subscribeAll receives entries from all services", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;

      // Collect 3 entries from the global subscription
      const collectEffect = log.subscribeAll().pipe(Stream.take(3), Stream.runCollect);
      const fiber = yield* Effect.forkChild(collectEffect);

      yield* Effect.yieldNow;

      yield* log.append("svcA", "stdout", "from-a");
      yield* log.append("svcB", "stderr", "from-b");
      yield* log.append("svcA", "stdout", "from-a-again");

      const entries = yield* Fiber.join(fiber);
      expect(entries).toHaveLength(3);
      expect(entries[0]?.service).toBe("svcA");
      expect(entries[1]?.service).toBe("svcB");
      expect(entries[2]?.service).toBe("svcA");
    }).pipe(Effect.provide(layer)),
  );

  it.live("multiple services are independent", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;
      yield* log.append("a", "stdout", "line-a1");
      yield* log.append("b", "stdout", "line-b1");
      yield* log.append("a", "stderr", "line-a2");
      yield* log.append("b", "stderr", "line-b2");

      const entriesA = yield* log.history("a", 100);
      const entriesB = yield* log.history("b", 100);

      expect(entriesA).toHaveLength(2);
      expect(entriesA.every((e) => e.service === "a")).toBe(true);
      expect(entriesA[0]?.line).toBe("line-a1");
      expect(entriesA[1]?.line).toBe("line-a2");

      expect(entriesB).toHaveLength(2);
      expect(entriesB.every((e) => e.service === "b")).toBe(true);
      expect(entriesB[0]?.line).toBe("line-b1");
      expect(entriesB[1]?.line).toBe("line-b2");
    }).pipe(Effect.provide(layer)),
  );

  it.live("historyAll returns merged entries in timestamp order and respects filters", () =>
    Effect.gen(function* () {
      const log = yield* LogBuffer;
      yield* log.append("a", "stdout", "line-a1");
      yield* Effect.sleep("1 millis");
      yield* log.append("b", "stderr", "line-b1");
      yield* Effect.sleep("1 millis");
      yield* log.append("a", "stdout", "line-a2");

      const merged = yield* log.historyAll(10);
      expect(merged.map((entry) => entry.line)).toEqual(["line-a1", "line-b1", "line-a2"]);

      const filtered = yield* log.historyAll(10, ["b"]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.service).toBe("b");
      expect(filtered[0]?.line).toBe("line-b1");
    }).pipe(Effect.provide(layer)),
  );
});
