import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import type * as Command from "foldkit/command";
import * as Subscription from "foldkit/subscription";
import type * as Update from "foldkit/update";

import { Key } from "../terminal/key.ts";
import * as Terminal from "../terminal/terminal.ts";
import { TestTerminal } from "../terminal/testing.ts";
import { screen } from "../view/screen.ts";
import { text } from "../view/view.ts";
import { keys, type Keys } from "./keys.ts";
import { makeProgram, run, type RunOptions } from "./run.ts";
import {
  directed,
  dropTrailingBlank,
  expectCursorVisible,
  frame,
  keyProgram,
  nextFrame,
  scripted,
  shown,
  startScripted,
  withTerminal,
  Written,
  type Directive,
  type Frame,
  type KeyMessage,
} from "./test-support.ts";

const released = { paused: true, raw: false, listenerCount: 0 };

const startKeys = (
  options: RunOptions = {},
  start: { readonly commands?: Update.Commands<KeyMessage> } = {},
) =>
  Effect.gen(function* () {
    const written = yield* Written;
    const running = yield* run(keyProgram(start), options).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* written.next;
    return running;
  });

const expectRestored = Effect.gen(function* () {
  const test = yield* TestTerminal;
  expect(yield* test.inputState).toEqual(released);
  expect(yield* test.rawModeTransitions).toEqual([true, false]);
});

/** A Command that signals `started`, then runs until interrupted and finalizes with `finalizer`. */
const lingering = (started: Deferred.Deferred<void>, finalizer: Effect.Effect<void>) =>
  ({
    name: "Linger",
    effect: Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(finalizer),
    ),
  }) satisfies Command.Command<KeyMessage>;

/** Takes one key, then sits in a sequential step that never pulls another. */
const busyAfterKey = (busy: Deferred.Deferred<void>) =>
  makeProgram({
    Model: Schema.Finite,
    init: () => ({ model: 0 }),
    update: (model) => ({ model }),
    view: () => screen(text("waiting")),
    subscriptions: Subscription.make<number, KeyMessage, Keys>()(() => ({
      keys: Subscription.persistentEntry(
        keys.pipe(
          Stream.mapEffect(() =>
            Deferred.succeed(busy, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      ),
    })),
    result: () => Option.none(),
  });

describe("Tui.run restoration", () => {
  it.effect("restores the terminal after success", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys();

        yield* test.type("q");
        expect(yield* Fiber.join(running)).toBe("stopped");

        yield* expectRestored;
        yield* expectCursorVisible;
        expect(yield* shown).toEqual(["keys: q"]);
      }),
    ),
  );

  it.effect("restores the terminal after a command defect", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const boom = new Error("boom");
        const go = yield* Deferred.make<void>();
        const running = yield* startKeys(
          {},
          {
            commands: [
              {
                name: "Explode",
                effect: Deferred.await(go).pipe(Effect.andThen(Effect.die(boom))),
              },
            ],
          },
        );

        yield* Deferred.succeed(go, undefined);
        const exit = yield* Fiber.await(running);

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(boom);
        yield* expectRestored;
        yield* expectCursorVisible;
        expect(yield* shown).toEqual(["keys:"]);
        expect(yield* test.cursor).toEqual({ x: 0, y: 1 });
      }),
    ),
  );

  it.effect("fails with a startup Command defect even when another Command finishes the run", () =>
    withTerminal(
      Effect.gen(function* () {
        const boom = new Error("startup boom");
        const finish: KeyMessage = { _tag: "PressedKey", key: Key.Char({ text: "q" }) };

        const running = yield* run(
          keyProgram({
            commands: [
              { name: "Finish", effect: Effect.succeed(finish) },
              { name: "Explode", effect: Effect.die(boom) },
            ],
          }),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        const exit = yield* Fiber.await(running);

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(boom);
        expect(yield* (yield* TestTerminal).inputState).toEqual(released);
        const bytes = yield* (yield* TestTerminal).rawBytes;
        expect(bytes.lastIndexOf("\u001b[?25l")).toBeLessThanOrEqual(
          bytes.lastIndexOf("\u001b[?25h"),
        );
      }),
    ),
  );

  it.effect("restores the terminal after interruption", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys();
        yield* test.type("a");
        yield* nextFrame;

        yield* Fiber.interrupt(running);

        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* expectRestored;
        yield* expectCursorVisible;
        expect(yield* shown).toEqual(["keys: a"]);
      }),
    ),
  );

  it.effect("fails with TerminalError when a write fails and still releases input", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys();

        yield* test.failWrites(new Error("EPIPE"));
        yield* test.type("a");
        yield* TestClock.adjust("16 millis");
        const error = yield* Effect.flip(Fiber.join(running));

        expect(error).toBeInstanceOf(Terminal.TerminalError);
        expect(error.reason).toBe("write");
        yield* expectRestored;
      }),
    ),
  );
});

describe("Tui.run keys that end the run", () => {
  it.effect("interrupts on Ctrl+C", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys();

        yield* test.type("\x03");

        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* expectRestored;
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect("delivers Ctrl+C to the program with handleCtrlC", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys({ handleCtrlC: true });

        yield* test.type("\x03");
        yield* nextFrame;
        expect(yield* shown).toEqual(["keys: Ctrl+c"]);
        expect(running.pollUnsafe()).toBeUndefined();

        yield* test.type("q");
        expect(yield* Fiber.join(running)).toBe("stopped");
        yield* expectRestored;
      }),
    ),
  );

  it.effect("interrupts when stdin ends, even with handleCtrlC", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys({ handleCtrlC: true });

        yield* test.end;

        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* expectRestored;
      }),
    ),
  );

  it.effect("delivers Escape as a key unless interruptOnEscape is set", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* startKeys();

        yield* test.type("\x1b");
        yield* TestClock.adjust("50 millis");
        yield* written.next;
        expect(yield* shown).toEqual(["keys: Escape"]);
        expect(running.pollUnsafe()).toBeUndefined();

        yield* test.type("q");
        yield* Fiber.join(running);
      }),
    ),
  );

  it.effect("delivers Alt+Backspace to the program under interruptOnEscape", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* startKeys({ interruptOnEscape: true });

        yield* test.type("\x1b\x7f");
        yield* TestClock.adjust("50 millis");
        yield* written.next;

        expect(yield* shown).toEqual(["keys: Meta+Backspace"]);
        expect(running.pollUnsafe()).toBeUndefined();

        yield* test.type("q");
        expect(yield* Fiber.join(running)).toBe("stopped");
      }),
    ),
  );

  it.live("interrupts a key-driven run whose stdin had already ended", () =>
    withTerminal(
      Effect.gen(function* () {
        const running = yield* run(keyProgram()).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );

        const exit = yield* Fiber.await(running).pipe(Effect.timeoutOption("2 seconds"));

        expect(Option.isSome(exit) && Exit.hasInterrupts(exit.value)).toBe(true);
        yield* expectRestored;
      }),
      { inputEnded: true },
    ),
  );

  it.effect("interrupts on Escape with interruptOnEscape", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* startKeys({ interruptOnEscape: true });

        yield* test.type("\x1b");
        yield* TestClock.adjust("50 millis");

        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* expectRestored;
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual(["keys:"]);
      }),
    ),
  );

  describe.each([
    {
      name: "Ctrl+C",
      options: {},
      press: (test: TestTerminal["Service"]) => test.type("\x03"),
    },
    {
      name: "end of input",
      options: { handleCtrlC: true },
      press: (test: TestTerminal["Service"]) => test.end,
    },
    {
      name: "Escape",
      options: { interruptOnEscape: true },
      press: (test: TestTerminal["Service"]) =>
        test.type("\x1b").pipe(Effect.andThen(TestClock.adjust("50 millis"))),
    },
  ])("$name while a subscription is busy with an earlier key", ({ options, press }) => {
    it.effect("interrupts the run and releases stdin", () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const written = yield* Written;
          const busy = yield* Deferred.make<void>();
          const running = yield* run(busyAfterKey(busy), options).pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* written.next;
          yield* test.type("a");
          yield* Deferred.await(busy);

          yield* press(test);

          expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
          yield* expectRestored;
        }),
      ),
    );
  });
});

describe("Tui.run shutdown", () => {
  it.effect("releases input while a command is still finalizing", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const started = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const running = yield* startKeys(
          {},
          {
            commands: [
              lingering(
                started,
                Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(gate))),
              ),
            ],
          },
        );
        yield* Deferred.await(started);

        yield* test.type("\x03");
        yield* Deferred.await(finalizing);

        expect(yield* test.inputState).toEqual(released);
        expect(running.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(gate, undefined);
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
      }),
    ),
  );

  it.effect("returns the result only after a Command that is still running has finalized", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const started = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const running = yield* startKeys(
          {},
          {
            commands: [
              lingering(
                started,
                Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(gate))),
              ),
            ],
          },
        );
        yield* Deferred.await(started);

        yield* test.type("q");
        yield* Deferred.await(finalizing);
        expect(yield* written.next).toContain("keys: q");
        const whileFinalizing = running.pollUnsafe();
        yield* Deferred.succeed(gate, undefined);

        expect(whileFinalizing).toBeUndefined();
        expect(yield* Fiber.join(running)).toBe("stopped");
        yield* expectRestored;
      }),
    ),
  );

  it.effect("fails with the defect of a Command finalizer that dies while the run finishes", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const started = yield* Deferred.make<void>();
        const boom = new Error("finalizer boom");
        const running = yield* startKeys({}, { commands: [lingering(started, Effect.die(boom))] });
        yield* Deferred.await(started);

        yield* test.type("q");
        const exit = yield* Fiber.await(running);

        expect(Exit.hasDies(exit)).toBe(true);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(boom);
        yield* expectRestored;
        yield* expectCursorVisible;
        expect(yield* shown).toEqual(["keys: q"]);
      }),
    ),
  );

  it.effect("cancels commands without waiting for a stalled redraw", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const running = yield* startKeys(
          {},
          { commands: [lingering(started, Deferred.succeed(cancelled, undefined))] },
        );
        yield* written.nextSubmitted;
        yield* Deferred.await(started);
        const stall = yield* test.stallWrites;
        yield* test.type("a");
        yield* TestClock.adjust("16 millis");
        yield* written.nextSubmitted;

        const interrupting = yield* Effect.forkScoped(Fiber.interrupt(running), {
          startImmediately: true,
        });
        yield* Deferred.await(cancelled);
        expect(interrupting.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("1 second");
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* stall.release;
        yield* expectRestored;
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect("writes nothing after the deadline while a Command finalizer is still running", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const started = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const running = yield* startKeys(
          {},
          {
            commands: [
              lingering(
                started,
                Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(gate))),
              ),
            ],
          },
        );
        yield* written.nextSubmitted;
        yield* Deferred.await(started);
        const stall = yield* test.stallWrites;
        yield* test.type("a");
        yield* TestClock.adjust("16 millis");
        yield* written.nextSubmitted;
        yield* test.type("b");
        yield* TestClock.adjust("16 millis");

        yield* test.type("\x03");
        yield* Deferred.await(finalizing);
        yield* TestClock.adjust("1 second");
        expect(running.pollUnsafe()).toBeUndefined();

        const submitted = yield* written.submitted;
        yield* written.discard;
        yield* stall.release;
        yield* written.next;
        expect(running.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(gate, undefined);
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        expect(yield* written.submitted).toEqual(submitted);
        yield* expectRestored;
      }),
    ),
  );

  it.effect("gives up on a stalled success flush after one second and writes nothing more", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* startKeys();
        yield* written.nextSubmitted;
        const stall = yield* test.stallWrites;

        yield* test.type("q");
        const flush = yield* written.nextSubmitted;
        const interrupting = yield* Effect.forkScoped(Fiber.interrupt(running), {
          startImmediately: true,
        });
        yield* TestClock.adjust("999 millis");
        expect(running.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("1 millis");
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* Fiber.join(interrupting);
        yield* expectRestored;

        const before = yield* test.rawBytes;
        expect(before).not.toContain("keys: q");
        const submitted = yield* written.submitted;
        yield* stall.release;
        expect(yield* test.rawBytes).toBe(`${before}${flush}`);
        expect(yield* written.submitted).toEqual(submitted);
      }),
    ),
  );

  it.effect("keeps the commit of the update that a Command defect follows", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const inbox = yield* Queue.unbounded<Directive>();
        const boom = new Error("boom");
        const running = yield* run(directed(inbox)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* written.next;

        yield* Queue.offer(inbox, {
          _tag: "Directed",
          frame: frame(["working"], { committed: ["saved"] }),
          commands: [{ name: "Explode", effect: Effect.die(boom) }],
        });
        const exit = yield* Fiber.await(running);

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(boom);
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual(["saved", "working"]);
        yield* expectCursorVisible;
      }),
    ),
  );

  describe.each([
    {
      name: "an empty final transaction",
      final: frame([], { committed: ["step one"], done: true }),
    },
    {
      name: "a final write that would succeed",
      final: frame(["end"], { committed: ["step one", "step two"], done: true }),
    },
  ])("a commit write still in flight when the run finishes with $name", ({ final }) => {
    it.effect("surfaces the commit write's failure", () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const inbox = yield* Queue.unbounded<Frame>();
          const finishing = yield* Deferred.make<void>();
          const program = scripted(inbox, frame(["working"], { committed: ["step one"] }));
          const stall = yield* test.stallNextWrite;
          const running = yield* run({
            ...program,
            result: (model) => {
              const outcome = program.result(model);
              if (Option.isSome(outcome)) Deferred.doneUnsafe(finishing, Exit.void);
              return outcome;
            },
          }).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* stall.captured;

          yield* Queue.offer(inbox, final);
          yield* Deferred.await(finishing);
          yield* stall.fail(new Error("EPIPE"));

          const error = yield* Effect.flip(Fiber.join(running));
          expect(error).toBeInstanceOf(Terminal.TerminalError);
        }),
        { isTTY: false },
      ),
    );
  });

  it.effect("erases only the rows it drew when a redraw fails to write", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const { inbox, running } = yield* startScripted;
        yield* Queue.offer(inbox, frame(["one", "two"], { committed: ["header"] }));
        yield* nextFrame;
        const stall = yield* test.stallNextWrite;

        yield* Queue.offer(inbox, frame(["a", "b", "c", "d", "e"], { committed: ["header"] }));
        yield* TestClock.adjust("16 millis");
        yield* stall.captured;
        yield* stall.fail(new Error("EPIPE"));

        const error = yield* Effect.flip(Fiber.join(running));
        expect(error).toBeInstanceOf(Terminal.TerminalError);
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual([
          "header",
          "a",
          "b",
          "c",
          "d",
          "e",
        ]);
      }),
    ),
  );

  it.effect("shows the cursor again when the final frame's write fails", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const observed = yield* Written;
        const { inbox, running } = yield* startScripted;
        yield* observed.nextSubmitted;
        const stall = yield* test.stallWrites;

        yield* Queue.offer(inbox, frame(["end"], { done: true }));
        yield* observed.nextSubmitted;
        yield* stall.fail(new Error("EPIPE"));

        const error = yield* Effect.flip(Fiber.join(running));
        expect(error).toBeInstanceOf(Terminal.TerminalError);
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect("shows the cursor when the pending final write fails while teardown waits", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const observed = yield* Written;
        const clock = yield* Clock.Clock;
        const waiting = yield* Deferred.make<void>();
        const inbox = yield* Queue.unbounded<Frame>();
        const running = yield* run(scripted(inbox)).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              Duration.toMillis(duration) === 1000
                ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(clock.sleep(duration)))
                : clock.sleep(duration),
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* observed.next;
        const stall = yield* test.stallNextWrite;
        yield* Queue.offer(inbox, frame(["end"], { done: true }));
        yield* stall.captured;

        const interrupting = yield* Effect.forkScoped(Fiber.interrupt(running), {
          startImmediately: true,
        });
        yield* Deferred.await(waiting);
        yield* stall.fail(new Error("EPIPE"));

        yield* Fiber.join(interrupting);
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect("fails when the update that finishes the run also returns a keyed Command", () =>
    withTerminal(
      Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<Directive>();
        const running = yield* run(directed(inbox)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );

        yield* Queue.offer(inbox, {
          _tag: "Directed",
          frame: frame(["end"], { done: true }),
          commands: [{ name: "Keyed", key: "slot", effect: Effect.never }],
        });
        const exit = yield* Fiber.await(running);

        expect(Exit.hasDies(exit)).toBe(true);
        expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("Keyed");
      }),
    ),
  );

  it.effect("rejects keyed Commands as defects", () =>
    withTerminal(
      Effect.gen(function* () {
        const running = yield* run(
          keyProgram({
            commands: [{ name: "Keyed", key: "slot", effect: Effect.never }],
          }),
        ).pipe(Effect.forkScoped({ startImmediately: true }));

        const exit = yield* Fiber.await(running);

        expect(Exit.hasDies(exit)).toBe(true);
        expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("Keyed");
      }),
    ),
  );
});
