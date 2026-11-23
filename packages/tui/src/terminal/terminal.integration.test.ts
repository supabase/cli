import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import type { InputStream } from "./input-session.ts";
import { Key } from "./key.ts";
import * as Terminal from "./terminal.ts";
import { layerTest, TestTerminal, type TestTerminalOptions } from "./testing.ts";

const withTerminal = <A, E>(
  body: (
    terminal: Terminal.Interface,
    test: TestTerminal["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: Partial<TestTerminalOptions> = {},
) =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Service;
    const test = yield* TestTerminal;
    return yield* body(terminal, test);
  }).pipe(Effect.scoped, Effect.provide(layerTest({ columns: 80, rows: 24, ...options })));

/** Runs the stream in a fiber that is already subscribed when this returns. */
const listen = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<A>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((item) => Queue.offer(received, item)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return { next: Queue.take(received), fiber };
  });

const released = { paused: true, raw: false, listenerCount: 0 };

const overrideEnv = (overrides: Readonly<Record<string, string | undefined>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );

const nodeCapabilities = Effect.gen(function* () {
  const terminal = yield* Terminal.Service;
  return terminal.capabilities;
}).pipe(Effect.provide(Terminal.layerProcess()));

describe("input session", () => {
  it.effect("decodes typed bytes into keys while holding the terminal in raw mode", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        const active = yield* test.inputState;
        expect(active).toMatchObject({ paused: false, raw: true });
        expect(active.listenerCount).toBeGreaterThan(0);

        yield* test.type("hi");
        yield* test.type("\r");
        yield* test.type("\x03");

        expect([yield* keys.next, yield* keys.next, yield* keys.next, yield* keys.next]).toEqual([
          Key.Char({ text: "h" }),
          Key.Char({ text: "i" }),
          Key.Enter({}),
          Key.Ctrl({ letter: "c" }),
        ]);
      }),
    ),
  );

  it.effect("reports a lone ESC as Escape once 50 ms pass", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        yield* test.type("\x1b");
        yield* TestClock.adjust("50 millis");

        expect(yield* keys.next).toEqual(Key.Escape());
      }),
    ),
  );

  it.effect("joins an escape sequence split across chunks within 50 ms", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        yield* test.type("\x1b");
        yield* TestClock.adjust("49 millis");
        yield* test.type("[A");
        expect(yield* keys.next).toEqual(Key.Up({}));

        // The timer armed by the lone ESC must not turn into a late Escape.
        yield* TestClock.adjust("1 second");
        yield* test.type("z");
        expect(yield* keys.next).toEqual(Key.Char({ text: "z" }));
      }),
    ),
  );

  it.effect("reports ESC then a key within 50 ms as that key with meta, never as Escape", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        yield* test.type("\x1b");
        yield* TestClock.adjust("49 millis");
        yield* test.type("\x7f");
        expect(yield* keys.next).toEqual(Key.Backspace({ meta: true }));

        yield* TestClock.adjust("1 second");
        yield* test.type("z");
        expect(yield* keys.next).toEqual(Key.Char({ text: "z" }));
      }),
    ),
  );

  it.effect.each([
    { name: "Alt+[", prefix: "\x1b[", expected: Key.Char({ text: "[", meta: true }) },
    { name: "Alt+Shift+O", prefix: "\x1bO", expected: Key.Char({ text: "O", meta: true }) },
  ])("reports $name when the bare ESC prefix is still alone after 50 ms", ({ prefix, expected }) =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        yield* test.type(prefix);
        yield* TestClock.adjust("50 millis");
        expect(yield* keys.next).toEqual(expected);

        yield* test.end;
        expect(yield* keys.next).toEqual(Key.Eof());
      }),
    ),
  );

  it.effect.each([
    { prefix: "\x1b[", continuation: "A", expected: Key.Up({}) },
    { prefix: "\x1bO", continuation: "H", expected: Key.Home({}) },
  ])(
    "still decodes $prefix plus $continuation arriving before the deadline as that key",
    ({ prefix, continuation, expected }) =>
      withTerminal((terminal, test) =>
        Effect.gen(function* () {
          const session = yield* terminal.openInput;
          const keys = yield* listen(session.keys);

          yield* test.type(prefix);
          yield* TestClock.adjust("49 millis");
          yield* test.type(continuation);
          expect(yield* keys.next).toEqual(expected);

          // The timer armed by the prefix must not add a late Meta character.
          yield* TestClock.adjust("1 second");
          yield* test.type("z");
          expect(yield* keys.next).toEqual(Key.Char({ text: "z" }));
        }),
      ),
  );

  it.effect.each([
    { flow: "is fresh and never read", inputFlowing: false, pausedAfter: true },
    { flow: "was already flowing", inputFlowing: true, pausedAfter: false },
  ])("with stdin that $flow, ends paused: $pausedAfter", ({ inputFlowing, pausedAfter }) =>
    withTerminal(
      (terminal, test) =>
        Effect.gen(function* () {
          const session = yield* terminal.openInput;
          const keys = yield* listen(session.keys);
          expect(yield* test.inputState).toMatchObject({ paused: false, raw: true });

          yield* session.close;
          yield* Fiber.join(keys.fiber);

          expect(yield* test.inputState).toEqual({
            paused: pausedAfter,
            raw: false,
            listenerCount: 0,
          });
        }),
      { inputFlowing },
    ),
  );

  it.effect("releases the terminal when the only stream ends", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys.pipe(Stream.take(1)));

        yield* test.type("a");
        yield* keys.next;
        yield* Fiber.join(keys.fiber);

        expect(yield* test.inputState).toEqual(released);
        expect(yield* test.rawModeTransitions).toEqual([true, false]);
      }),
    ),
  );

  it.effect("releases the terminal and ends active streams when the scope closes", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const session = yield* terminal.openInput.pipe(Scope.provide(scope));
        const keys = yield* listen(session.keys);
        expect(yield* test.rawModeTransitions).toEqual([true]);

        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(keys.fiber);

        expect(yield* test.inputState).toEqual(released);
        expect(yield* test.rawModeTransitions).toEqual([true, false]);
      }),
    ),
  );

  it.effect("shares one acquisition between overlapping streams", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const first = yield* listen(session.keys);
        const second = yield* listen(session.keys);

        yield* test.type("k");
        expect(yield* first.next).toEqual(Key.Char({ text: "k" }));
        expect(yield* second.next).toEqual(Key.Char({ text: "k" }));
        expect(yield* test.rawModeTransitions).toEqual([true]);

        yield* Fiber.interrupt(first.fiber);
        expect(yield* test.inputState).toMatchObject({ paused: false, raw: true });

        yield* test.type("m");
        expect(yield* second.next).toEqual(Key.Char({ text: "m" }));

        yield* Fiber.interrupt(second.fiber);
        expect(yield* test.inputState).toEqual(released);
        expect(yield* test.rawModeTransitions).toEqual([true, false]);
      }),
    ),
  );

  it.effect("re-acquires the terminal for a stream opened after the previous one ended", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;

        const first = yield* listen(session.keys.pipe(Stream.take(1)));
        yield* test.type("1");
        yield* first.next;
        yield* Fiber.join(first.fiber);

        const second = yield* listen(session.keys.pipe(Stream.take(1)));
        yield* test.type("2");
        expect(yield* second.next).toEqual(Key.Char({ text: "2" }));
        yield* Fiber.join(second.fiber);

        expect(yield* test.rawModeTransitions).toEqual([true, false, true, false]);
        expect(yield* test.inputState).toEqual(released);
      }),
    ),
  );

  it.effect("close ends an active stream and releases even with streams still attached", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const first = yield* listen(session.keys);
        const second = yield* listen(session.keys);

        yield* session.close;
        yield* Fiber.join(first.fiber);
        yield* Fiber.join(second.fiber);

        expect(yield* test.inputState).toEqual(released);
        expect(yield* test.rawModeTransitions).toEqual([true, false]);
      }),
    ),
  );

  it.effect("yields an empty stream after close and never touches raw mode again", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        yield* session.close;
        yield* session.close;

        const keys = yield* Stream.runCollect(session.keys);

        expect(keys).toEqual([]);
        expect(yield* test.rawModeTransitions).toEqual([]);
        expect(yield* test.inputState).toEqual(released);
      }),
    ),
  );

  it.effect("closes the session when its scope closes, leaving later streams empty", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const session = yield* terminal.openInput.pipe(Scope.provide(scope));
        yield* Scope.close(scope, Exit.void);

        expect(yield* Stream.runCollect(session.keys)).toEqual([]);
        expect(yield* test.rawModeTransitions).toEqual([]);
      }),
    ),
  );

  it.effect("emits Eof when stdin ends and then ends the stream", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        yield* test.type("a");
        yield* test.end;

        expect(yield* keys.next).toEqual(Key.Char({ text: "a" }));
        expect(yield* keys.next).toEqual(Key.Eof());
        yield* Fiber.join(keys.fiber);
        expect(yield* test.inputState).toEqual(released);
      }),
    ),
  );

  it.live("delivers Eof to the observer and the first stream when stdin had already ended", () =>
    withTerminal(
      (terminal, test) =>
        Effect.gen(function* () {
          const session = yield* terminal.openInput;
          const observed: Array<Key> = [];
          yield* session.observe((key) => observed.push(key));
          const keys = yield* listen(session.keys);

          const first = yield* keys.next.pipe(Effect.timeoutOption("2 seconds"));
          expect(first).toEqual(Option.some(Key.Eof()));
          yield* Fiber.join(keys.fiber);
          expect(observed).toEqual([Key.Eof()]);
          expect(yield* test.inputState).toEqual(released);
        }),
      { inputEnded: true },
    ),
  );

  it.effect("flushes a pending ESC before Eof", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const session = yield* terminal.openInput;
        const keys = yield* listen(session.keys);

        yield* test.type("\x1b");
        yield* test.end;

        expect(yield* keys.next).toEqual(Key.Escape());
        expect(yield* keys.next).toEqual(Key.Eof());
      }),
    ),
  );

  it.effect("does not touch raw mode when stdin is not a TTY", () =>
    withTerminal(
      (terminal, test) =>
        Effect.gen(function* () {
          const session = yield* terminal.openInput;
          const keys = yield* listen(session.keys.pipe(Stream.take(1)));

          yield* test.type("p");
          expect(yield* keys.next).toEqual(Key.Char({ text: "p" }));
          yield* Fiber.join(keys.fiber);

          expect(yield* test.rawModeTransitions).toEqual([]);
          expect(yield* test.inputState).toEqual(released);
        }),
      { inputIsTTY: false },
    ),
  );
});

describe("terminal output", () => {
  it.effect("shows written bytes on the screen", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        yield* terminal.write("hello\r\nworld");

        expect((yield* test.screenText).slice(0, 2)).toEqual(["hello", "world"]);
        expect(yield* test.rawBytes).toBe("hello\r\nworld");
        expect(yield* test.cursor).toEqual({ x: 5, y: 1 });
      }),
    ),
  );

  it.effect("completes a write only after the stream accepts it", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const stall = yield* test.stallWrites;
        const write = yield* terminal
          .write("later")
          .pipe(Effect.forkChild({ startImmediately: true }));

        expect(write.pollUnsafe()).toBeUndefined();
        expect(yield* test.rawBytes).toBe("");

        yield* stall.release;
        yield* Fiber.join(write);

        expect((yield* test.screenText)[0]).toBe("later");
      }),
    ),
  );

  it.effect("surfaces a failed write as TerminalError", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        const epipe = new Error("write EPIPE");
        yield* test.failWrites(epipe);

        const error = yield* terminal.write("x").pipe(Effect.flip);

        expect(error).toBeInstanceOf(Terminal.TerminalError);
        expect(error.reason).toBe("write");
        expect(error.cause).toBe(epipe);
      }),
    ),
  );

  it.effect("reports the new size on resize", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        expect(yield* terminal.size).toEqual({ columns: 80, rows: 24 });
        const resizes = yield* listen(terminal.resizes);

        yield* test.resize({ columns: 60, rows: 10 });

        expect(yield* resizes.next).toEqual({ columns: 60, rows: 10 });
        expect(yield* terminal.size).toEqual({ columns: 60, rows: 10 });
      }),
    ),
  );

  it.effect("samples the smallest size seen since the previous sample, even after a regrow", () =>
    withTerminal((terminal, test) =>
      Effect.gen(function* () {
        yield* test.resize({ columns: 30, rows: 8 });
        yield* test.resize({ columns: 80, rows: 24 });

        expect(yield* terminal.sampleGeometry).toEqual({
          current: { columns: 80, rows: 24 },
          smallest: { columns: 30, rows: 8 },
        });
        expect(yield* terminal.sampleGeometry).toEqual({
          current: { columns: 80, rows: 24 },
          smallest: { columns: 80, rows: 24 },
        });
      }),
    ),
  );
});

const idleStreams = (input: InputStream): Terminal.Streams => ({
  input,
  output: { write: (_, callback) => callback(null), on: () => {}, off: () => {} },
  env: { TERM: "xterm-256color" },
});

describe("input ownership", () => {
  const input: InputStream = { resume: () => {}, pause: () => {}, on: () => {}, off: () => {} };

  it.effect("is shared by every terminal built over the same input stream", () =>
    Effect.gen(function* () {
      const first = yield* Terminal.make(idleStreams(input));
      const second = yield* Terminal.make(idleStreams(input));

      const held = yield* Scope.make();
      yield* first.claim.pipe(Scope.provide(held));
      const refused = yield* second.claim.pipe(Effect.scoped, Effect.flip);
      yield* Scope.close(held, Exit.void);
      yield* second.claim.pipe(Effect.scoped);

      expect(refused.reason).toBe("busy");
    }).pipe(Effect.scoped),
  );

  it.effect("is independent between input streams", () =>
    Effect.gen(function* () {
      const first = yield* Terminal.make(idleStreams(input));
      const other = yield* Terminal.make(idleStreams({ ...input }));

      yield* first.claim;
      yield* other.claim;
    }).pipe(Effect.scoped),
  );
});

describe("layerProcess", () => {
  it.effect("detects capabilities from the process environment, empty strings included", () =>
    Effect.gen(function* () {
      yield* overrideEnv({
        NO_COLOR: undefined,
        FORCE_COLOR: "",
        TERM: "xterm",
        LANG: "en_US.UTF-8",
        LC_ALL: undefined,
        LC_CTYPE: undefined,
      });

      expect(yield* nodeCapabilities).toMatchObject({ colorLevel: 1, unicode: true });
    }),
  );

  it.effect("lets NO_COLOR win over FORCE_COLOR", () =>
    Effect.gen(function* () {
      yield* overrideEnv({ NO_COLOR: "1", FORCE_COLOR: "3", LANG: "C", LC_ALL: undefined });

      expect(yield* nodeCapabilities).toMatchObject({ colorLevel: 0, unicode: false });
    }),
  );
});
