import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Terminal } from "effect";
import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";
import { browseLogs, type LogsBrowserSink } from "./logs.browser.ts";
import { LogsClipboard } from "./logs.clipboard.ts";
import { LogsClipboardError } from "./logs.errors.ts";

const key = (name: string, modifiers: Partial<Terminal.Key> = {}): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false, ...modifiers },
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const first = {
  id: "first",
  timestamp: "2026-11-03T16:51:32.123456Z",
  event_message: "你好\nfull first log",
  metadata: { nested: [1, true, { trace_id: "correlation" }] },
};
const second = {
  id: "second",
  timestamp: "2026-11-03T16:51:33Z",
  event_message: "second log",
  metadata: { raw: "\u001b[31mraw control", long: "z".repeat(1000) },
};

const setup = Effect.fnUntraced(function* (
  produce: (sink: LogsBrowserSink) => Effect.Effect<void>,
  copy: (text: string) => Effect.Effect<void, LogsClipboardError>,
) {
  const input = yield* Queue.unbounded<Terminal.UserInput>();
  const screens = yield* Queue.unbounded<string>();
  const control = mockProcessControl();
  const fiber = yield* browseLogs(produce).pipe(
    Effect.provideService(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(12),
        readInput: Effect.succeed(input),
        readLine: Effect.die("unused"),
        display: (text) => Queue.offer(screens, text).pipe(Effect.asVoid),
      }),
    ),
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LogsClipboard, { copy }), mockOutput().layer, control.layer),
    ),
    Effect.forkScoped,
  );
  yield* Queue.take(screens);
  yield* Queue.take(screens);
  return { input, screens, fiber, control };
});

it.effect("copies complete selected records, snapshots pending copies, and preserves Ctrl-C", () =>
  Effect.gen(function* () {
    const copied = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    let copies = 0;
    const browser = yield* setup(
      (sink) =>
        Effect.gen(function* () {
          yield* sink.entry(first);
          yield* sink.entry(second);
          return yield* Effect.never;
        }),
      (text) =>
        Effect.gen(function* () {
          copies++;
          yield* Queue.offer(copied, text);
          yield* Deferred.await(release);
        }),
    );
    yield* Queue.take(browser.screens);
    yield* Queue.take(browser.screens);
    yield* Queue.offer(browser.input, key("c"));
    expect(yield* Queue.take(browser.screens)).toContain("Copying log…");
    const captured = yield* Queue.take(copied);
    expect(decodeRecord(captured)).toEqual(second);
    expect(captured).toContain('\n  "id": "second",\n');
    expect(captured).toContain('\n  "metadata": {\n');
    yield* Queue.offer(browser.input, key("up"));
    expect(yield* Queue.take(browser.screens)).toContain("> Nov 03 - 16:51:32 UTC");
    yield* Queue.offer(browser.input, key("c"));
    yield* Queue.take(browser.screens);
    expect(copies).toBe(1);
    yield* Deferred.succeed(release, undefined);
    expect((yield* Queue.take(browser.screens)).split("\r\n").at(-1)).toContain(
      "Copied log to clipboard.",
    );
    yield* Queue.offer(browser.input, key("return"));
    expect(yield* Queue.take(browser.screens)).toContain("Log details");
    yield* Queue.offer(browser.input, key("C", { shift: true }));
    yield* Queue.take(browser.screens);
    expect(decodeRecord(yield* Queue.take(copied))).toEqual(first);
    yield* Queue.take(browser.screens);
    yield* Queue.offer(browser.input, key("c", { meta: true }));
    yield* Queue.take(browser.screens);
    expect(copies).toBe(2);
    yield* Queue.offer(browser.input, key("c", { ctrl: true }));
    yield* Fiber.join(browser.fiber);
    expect(browser.control.exitCode).toBe(130);
    expect(copies).toBe(2);
  }),
);

it.effect("copies pinned details after their original row is evicted", () =>
  Effect.gen(function* () {
    const evict = yield* Deferred.make<void>();
    const copied = yield* Queue.unbounded<string>();
    const browser = yield* setup(
      (sink) =>
        Effect.gen(function* () {
          yield* sink.entry(first);
          yield* Deferred.await(evict);
          for (let index = 0; index < 1000; index++)
            yield* sink.entry({ id: `replacement-${index}`, message: `replacement-${index}` });
          yield* sink.notice("Retention settled");
          return yield* Effect.never;
        }),
      (text) => Queue.offer(copied, text).pipe(Effect.asVoid),
    );
    yield* Queue.take(browser.screens);
    yield* Queue.offer(browser.input, key("return"));
    expect(yield* Queue.take(browser.screens)).toContain("Log details");
    yield* Deferred.succeed(evict, undefined);
    let settled = "";
    while (!settled.includes("Retention settled")) settled = yield* Queue.take(browser.screens);
    yield* Queue.offer(browser.input, key("C"));
    yield* Queue.take(browser.screens);
    expect(decodeRecord(yield* Queue.take(copied))).toEqual(first);
    expect(yield* Queue.take(browser.screens)).toContain("Copied log to clipboard.");
    yield* Queue.offer(browser.input, key("escape"));
    const retained = yield* Queue.take(browser.screens);
    expect(retained).toContain("> — — replacement-0");
    expect(retained).not.toContain("full first log");
    yield* Queue.offer(browser.input, key("q"));
    yield* Fiber.join(browser.fiber);
  }),
);

it.effect("reports a failed copy visibly and keeps navigation usable", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const browser = yield* setup(
      (sink) =>
        Effect.gen(function* () {
          yield* sink.entry(first);
          yield* sink.entry(second);
          return yield* Effect.never;
        }),
      () => {
        attempts++;
        return attempts > 1
          ? Effect.void
          : Effect.fail(
              new LogsClipboardError({
                reason: "unavailable",
                message: "Install wl-clipboard, xclip, or xsel to copy.",
              }),
            );
      },
    );
    yield* Queue.take(browser.screens);
    yield* Queue.take(browser.screens);
    yield* Queue.offer(browser.input, key("c"));
    yield* Queue.take(browser.screens);
    const footer = (yield* Queue.take(browser.screens)).split("\r\n").at(-1);
    expect(footer).toContain("Install wl-clipboard, xclip, or xsel to copy.");
    expect(footer).toContain("C copy · q quit");
    yield* Queue.offer(browser.input, key("up"));
    expect(yield* Queue.take(browser.screens)).toContain("> Nov 03 - 16:51:32 UTC");
    yield* Queue.offer(browser.input, key("c"));
    expect(yield* Queue.take(browser.screens)).toContain("Copying log…");
    expect(yield* Queue.take(browser.screens)).toContain("Copied log to clipboard.");
    expect(attempts).toBe(2);
    yield* Queue.offer(browser.input, key("return"));
    expect(yield* Queue.take(browser.screens)).toContain("Log details");
    yield* Queue.offer(browser.input, key("q"));
    yield* Fiber.join(browser.fiber);
  }),
);

it.effect("ignores copy on an empty live list and interrupts pending clipboard work on quit", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const add = yield* Deferred.make<void>();
    let copies = 0;
    const browser = yield* setup(
      (sink) =>
        Effect.gen(function* () {
          yield* Deferred.await(add);
          yield* sink.entry(first);
          return yield* Effect.never;
        }),
      () =>
        Effect.gen(function* () {
          copies++;
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    );
    yield* Queue.offer(browser.input, key("c"));
    expect(yield* Queue.take(browser.screens)).toContain("Waiting for logs");
    expect(copies).toBe(0);
    yield* Deferred.succeed(add, undefined);
    yield* Queue.take(browser.screens);
    yield* Queue.offer(browser.input, key("c"));
    yield* Queue.take(browser.screens);
    yield* Deferred.await(ready);
    yield* Queue.offer(browser.input, key("q"));
    yield* Fiber.join(browser.fiber);
    yield* Deferred.await(stopped);
    expect(copies).toBe(1);
  }),
);
