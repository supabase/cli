import process from "node:process";
import { expect, it } from "@effect/vitest";
import { Cause, Exit, Deferred, Effect, Fiber, Layer, Option, Queue, Terminal } from "effect";
import type { OutputFormat } from "../../shared/output/types.ts";
import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { browseLogs, useLogsBrowser } from "./logs.browser.ts";

const key = (name: string, ctrl = false): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl, shift: false, meta: false },
});

it.effect("navigates full details, resizes, and interrupts the live producer on quit", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const screens = yield* Queue.unbounded<string>();
    const stopped = yield* Deferred.make<void>();
    let columns = 100;
    const listeners = process.stdout.listenerCount("resize");
    const terminal = Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.sync(() => columns),
        rows: Effect.succeed(8),
        readInput: Effect.succeed(input),
        readLine: Effect.die("unused"),
        display: (text) => Queue.offer(screens, text).pipe(Effect.asVoid),
      }),
    );
    const output = mockOutput();
    const browser = yield* browseLogs((sink) =>
      Effect.gen(function* () {
        yield* sink.entry({
          ts_ms: 0,
          service: "postgres",
          event_message: "first",
          secret: "full first detail",
        });
        yield* sink.entry({
          ts_ms: 1,
          service: "auth",
          event_message: "second",
          secret: "full second detail",
          long: "line\n".repeat(30) + "final-value",
        });
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    ).pipe(
      Effect.provide(Layer.mergeAll(terminal, output.layer, mockProcessControl().layer)),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(screens)).toContain("?1049h");
    expect(yield* Queue.take(screens)).toContain("Waiting for logs");
    expect(yield* Queue.take(screens)).toContain("first");
    expect(yield* Queue.take(screens)).toContain("> Jan 01 - 00:00:00 UTC auth second");
    yield* Queue.offer(input, key("up"));
    expect(yield* Queue.take(screens)).toContain("> Jan 01 - 00:00:00 UTC postgres first");
    yield* Queue.offer(input, key("return"));
    expect(yield* Queue.take(screens)).toContain("full first detail");
    yield* Queue.offer(input, key("escape"));
    expect(yield* Queue.take(screens)).toContain("Enter details");
    columns = 25;
    process.stdout.emit("resize");
    const resized = yield* Queue.take(screens);
    expect(resized).not.toContain("Jan 01 - 00:00:00 UTC postgres first");
    expect(
      resized
        .split("\r\n")
        .slice(1)
        .every((line) => line.length <= 24),
    ).toBe(true);
    yield* Queue.offer(input, key("q"));
    yield* Fiber.join(browser);
    yield* Deferred.await(stopped);
    expect(yield* Queue.take(screens)).toContain("?1049l");
    expect(process.stdout.listenerCount("resize")).toBe(listeners);
  }),
);

it.effect("persists a resized live viewport when more rows arrive while browsing", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const screens = yield* Queue.unbounded<string>();
    const append = yield* Deferred.make<void>();
    let height = 10;
    const browser = yield* browseLogs((sink) =>
      Effect.gen(function* () {
        for (let index = 0; index < 20; index++) yield* sink.entry({ message: `runtime-${index}` });
        yield* Deferred.await(append);
        yield* sink.entry({ message: "runtime-20" });
        return yield* Effect.never;
      }),
    ).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.sync(() => height),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) => Queue.offer(screens, text).pipe(Effect.asVoid),
        }),
      ),
      Effect.provide(Layer.mergeAll(mockOutput().layer, mockProcessControl().layer)),
      Effect.forkScoped,
    );
    yield* Queue.take(screens);
    yield* Queue.take(screens);
    let frame = "";
    for (let index = 0; index < 20; index++) frame = yield* Queue.take(screens);
    expect(frame.split("\r\n")[1]).toContain("runtime-12");
    for (let index = 0; index < 3; index++) {
      yield* Queue.offer(input, key("up"));
      frame = yield* Queue.take(screens);
    }
    expect(frame.split("\r\n")[1]).toContain("runtime-12");
    height = 14;
    process.stdout.emit("resize");
    frame = yield* Queue.take(screens);
    const before = frame.split("\r\n").slice(1, 13);
    expect(before[0]).toContain("runtime-8");
    yield* Deferred.succeed(append, undefined);
    frame = yield* Queue.take(screens);
    expect(frame.split("\r\n").slice(1, 13)).toEqual(before);
    yield* Queue.offer(input, key("return"));
    expect(yield* Queue.take(screens)).toContain("Log details");
    yield* Queue.offer(input, key("escape"));
    expect((yield* Queue.take(screens)).split("\r\n").slice(1, 13)).toEqual(before);
    yield* Queue.offer(input, key("q"));
    yield* Fiber.join(browser);
  }),
);

it.effect("restores the terminal and propagates producer failures", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const displays: string[] = [];
    const result = yield* browseLogs(() => Effect.fail("producer failed")).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(10),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) =>
            Effect.sync(() => {
              displays.push(text);
            }),
        }),
      ),
      Effect.provide(Layer.mergeAll(mockOutput().layer, mockProcessControl().layer)),
      Effect.result,
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: "producer failed" });
    expect(displays.at(-1)).toContain("?25h\u001b[?1049l");
  }),
);

it.effect("sets exit 130 for a raw Ctrl-C key and restores terminal state", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const screens = yield* Queue.unbounded<string>();
    const control = mockProcessControl();
    const browser = yield* browseLogs(() => Effect.never).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(10),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) => Queue.offer(screens, text).pipe(Effect.asVoid),
        }),
      ),
      Effect.provide(Layer.mergeAll(mockOutput().layer, control.layer)),
      Effect.forkScoped,
    );
    yield* Queue.take(screens);
    yield* Queue.take(screens);
    yield* Queue.offer(input, key("c", true));
    yield* Fiber.join(browser);
    expect(control.exitCode).toBe(130);
    expect(yield* Queue.take(screens)).toContain("?1049l");
  }),
);

it.effect("quits while a large producer is backpressured and finalizes it", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const stopped = yield* Deferred.make<void>();
    const backpressured = yield* Deferred.make<void>();
    let drewRow = false;
    const browser = yield* browseLogs((sink) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 2000 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              if (index === 64) yield* Deferred.succeed(backpressured, undefined);
              yield* sink.entry({ message: `row-${index}` });
            }),
          { discard: true },
        );
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    ).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(10),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) =>
            Effect.gen(function* () {
              if (!drewRow && text.includes("row-0")) {
                drewRow = true;
                yield* Deferred.await(backpressured);
                yield* Queue.offer(input, key("q"));
              }
            }),
        }),
      ),
      Effect.provide(Layer.mergeAll(mockOutput().layer, mockProcessControl().layer)),
      Effect.forkScoped,
    );
    yield* Fiber.join(browser);
    yield* Deferred.await(stopped);
    expect(drewRow).toBe(true);
  }),
);

it.effect("exits empty finite results with the normal message", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const output = mockOutput();
    const screens: string[] = [];
    yield* browseLogs(() => Effect.void).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(10),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) =>
            Effect.sync(() => {
              screens.push(text);
            }),
        }),
      ),
      Effect.provide(Layer.mergeAll(output.layer, mockProcessControl().layer)),
    );
    expect(screens.at(-1)).toContain("?1049l");
    expect(output.rawChunks).toEqual([{ text: "No log rows.\n", stream: "stdout" }]);
  }),
);

const interactionCases: ReadonlyArray<readonly [OutputFormat, boolean, boolean, boolean, boolean]> =
  [
    ["text", true, true, true, true],
    ["text", true, false, true, false],
    ["text", true, true, false, false],
    ["text", false, true, true, false],
    ["json", true, true, true, false],
    ["stream-json", true, true, true, false],
  ];
it.effect.each(interactionCases)(
  "requires text output and two interactive terminal streams: %j",
  ([format, interactive, stdinIsTty, stdoutIsTty, expected]) =>
    Effect.gen(function* () {
      const output = mockOutput({ format, interactive });
      const enabled = yield* useLogsBrowser().pipe(
        Effect.provide(output.layer),
        Effect.provideService(Tty, { stdinIsTty, stdoutIsTty, stdoutIsPipe: false }),
      );
      expect(enabled).toBe(expected);
    }),
);

it.effect("restores the screen when entering the terminal fails after a partial write", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput>();
    const writes: string[] = [];
    const exit = yield* browseLogs(() => Effect.never).pipe(
      Effect.provideService(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(10),
          readInput: Effect.succeed(input),
          readLine: Effect.die("unused"),
          display: (text) =>
            Effect.gen(function* () {
              writes.push(text);
              if (writes.length === 1) return yield* Effect.die("partial display failure");
            }),
        }),
      ),
      Effect.provide(Layer.mergeAll(mockOutput().layer, mockProcessControl().layer)),
      Effect.exit,
    );
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("partial display failure");
    expect(writes).toEqual(["\u001b[?1049h\u001b[?25l", "\u001b[?25h\u001b[?1049l"]);
  }),
);
