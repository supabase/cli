import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Terminal } from "effect";
import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";
import { browseLogs } from "./logs.browser.ts";
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
  produce: (
    pass: number,
    emit: (row: Schema.JsonObject) => Effect.Effect<void>,
  ) => Effect.Effect<void>,
  copy: (text: string) => Effect.Effect<void, LogsClipboardError>,
) {
  const input = yield* Queue.unbounded<Terminal.UserInput>();
  const screens = yield* Queue.unbounded<string>();
  const control = mockProcessControl();
  let pass = 0;
  const fiber = yield* browseLogs(
    {
      mode: "append",
      load: (_end, emit) =>
        produce(++pass, emit).pipe(
          Effect.as({ kind: "range", start: "2026-11-03T16:00:00Z", end: "2026-11-04T00:00:00Z" }),
        ),
    },
    0,
  ).pipe(
    Effect.provideService(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(12),
        size: Queue.unbounded<Terminal.Size, Cause.Done>(),
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
  let ready = "";
  while (!ready.includes(" | ready")) ready = yield* Queue.take(screens);
  return { input, screens, fiber, control };
});
const initial = (_pass: number, emit: (row: Schema.JsonObject) => Effect.Effect<void>) =>
  Effect.forEach([first, second], emit, { discard: true });

it.effect("copies complete selected records, snapshots pending copies, and preserves Ctrl-C", () =>
  Effect.gen(function* () {
    const copied = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    let copies = 0;
    const ui = yield* setup(initial, (text) =>
      Effect.gen(function* () {
        copies++;
        yield* Queue.offer(copied, text);
        yield* Deferred.await(release);
      }),
    );
    yield* Queue.offer(ui.input, key("c"));
    expect(yield* Queue.take(ui.screens)).toContain("Copying log…");
    const captured = yield* Queue.take(copied);
    expect(decodeRecord(captured)).toEqual(second);
    expect(captured).toContain('\n  "metadata": {\n');
    yield* Queue.offer(ui.input, key("up"));
    expect(yield* Queue.take(ui.screens)).toContain("> Nov 03 - 16:51:32 UTC");
    yield* Queue.offer(ui.input, key("c"));
    yield* Queue.take(ui.screens);
    expect(copies).toBe(1);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Queue.take(ui.screens)).toContain("Copied log to clipboard.");
    yield* Queue.offer(ui.input, key("return"));
    yield* Queue.take(ui.screens);
    yield* Queue.offer(ui.input, key("C", { shift: true }));
    yield* Queue.take(ui.screens);
    expect(decodeRecord(yield* Queue.take(copied))).toEqual(first);
    yield* Queue.take(ui.screens);
    yield* Queue.offer(ui.input, key("c", { meta: true }));
    yield* Queue.take(ui.screens);
    expect(copies).toBe(2);
    yield* Queue.offer(ui.input, key("c", { ctrl: true }));
    yield* Fiber.join(ui.fiber);
    expect(ui.control.exitCode).toBe(130);
    expect(copies).toBe(2);
  }),
);

it.effect("copies pinned details after a manual refresh evicts their original row", () =>
  Effect.gen(function* () {
    const copied = yield* Queue.unbounded<string>();
    const ui = yield* setup(
      (pass, emit) =>
        pass === 1
          ? emit(first)
          : Effect.forEach(
              Array.from({ length: 1000 }, (_, index) => index),
              (index) =>
                emit({
                  id: `replacement-${index}`,
                  ts_ms: Date.parse("2026-11-04T00:00:00Z") + index,
                  message: `replacement-${index}`,
                }),
              { discard: true },
            ),
      (text) => Queue.offer(copied, text).pipe(Effect.asVoid),
    );
    yield* Queue.offer(ui.input, key("return"));
    expect(yield* Queue.take(ui.screens)).toContain("Log details");
    yield* Queue.offer(ui.input, key("L"));
    let loaded = "";
    while (!loaded.includes("Newer logs loaded.")) loaded = yield* Queue.take(ui.screens);
    yield* Queue.offer(ui.input, key("C"));
    yield* Queue.take(ui.screens);
    expect(decodeRecord(yield* Queue.take(copied))).toEqual(first);
    expect(yield* Queue.take(ui.screens)).toContain("Copied log to clipboard.");
    yield* Queue.offer(ui.input, key("escape"));
    const retained = yield* Queue.take(ui.screens);
    expect(retained).toContain("replacement-0");
    expect(retained).not.toContain("full first log");
    yield* Queue.offer(ui.input, key("q"));
    yield* Fiber.join(ui.fiber);
  }),
);

it.effect("reports copy failure visibly and permits navigation and retry", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const ui = yield* setup(initial, () =>
      ++attempts > 1
        ? Effect.void
        : Effect.fail(
            new LogsClipboardError({
              reason: "unavailable",
              message: "Install wl-clipboard, xclip, or xsel to copy.",
            }),
          ),
    );
    yield* Queue.offer(ui.input, key("c"));
    yield* Queue.take(ui.screens);
    const footer = (yield* Queue.take(ui.screens)).split("\r\n").at(-1);
    expect(footer).toContain("Install wl-clipboard");
    expect(footer).toContain("L newer");
    expect(footer).toContain("C copy · q quit");
    yield* Queue.offer(ui.input, key("up"));
    expect(yield* Queue.take(ui.screens)).toContain("> Nov 03 - 16:51:32 UTC");
    yield* Queue.offer(ui.input, key("c"));
    yield* Queue.take(ui.screens);
    expect(yield* Queue.take(ui.screens)).toContain("Copied log to clipboard.");
    expect(attempts).toBe(2);
    yield* Queue.offer(ui.input, key("q"));
    yield* Fiber.join(ui.fiber);
  }),
);

it.effect("ignores empty copy and cancels pending clipboard work on quit", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    let copies = 0;
    const ui = yield* setup(
      (pass, emit) => (pass === 1 ? Effect.void : emit(first)),
      () =>
        Effect.gen(function* () {
          copies++;
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    );
    yield* Queue.offer(ui.input, key("c"));
    expect(yield* Queue.take(ui.screens)).toContain("No log rows.");
    expect(copies).toBe(0);
    yield* Queue.offer(ui.input, key("L"));
    let loaded = "";
    while (!loaded.includes("Newer logs loaded.")) loaded = yield* Queue.take(ui.screens);
    yield* Queue.offer(ui.input, key("c"));
    yield* Queue.take(ui.screens);
    yield* Deferred.await(ready);
    yield* Queue.offer(ui.input, key("q"));
    yield* Fiber.join(ui.fiber);
    yield* Deferred.await(stopped);
    expect(copies).toBe(1);
  }),
);
