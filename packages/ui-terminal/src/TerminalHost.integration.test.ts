import { UiSchema } from "@effect/ui";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Terminal, TerminalCommand, TerminalHost, TerminalSubscription } from "./index.ts";
import { TerminalTest, TestTerminalEvents } from "./testing/index.ts";

const CounterMessage = UiSchema.TaggedEnum({ Up: {}, Down: {}, Reset: {}, Done: {} });

const Counter = Terminal.component({
  name: "Counter",
  model: Schema.Struct({ count: Schema.Finite }),
  message: CounterMessage,
}).make({
  init: () => ({ count: 0 }),
  update: {
    Up: ($) => $.evolve({ count: (n) => n + 1 }),
    Down: ($) => $.evolve({ count: (n) => n - 1 }),
    Reset: ($) => $.evolve({ count: 0 }),
    Done: ($) => $.run(TerminalCommand.finish()),
  },
  subscriptions: () => [
    TerminalSubscription.shortcuts([
      { key: "up", message: CounterMessage.Up() },
      { key: "+", message: CounterMessage.Up() },
      { key: "down", message: CounterMessage.Down() },
      { key: "escape", message: CounterMessage.Down() },
      { key: "r", message: CounterMessage.Reset() },
      { key: "return", message: CounterMessage.Done() },
    ]),
  ],
  view: (h, model) =>
    h.box
      .style({ flexDirection: "column" })
      .children(
        h.text.style({ bold: true }).children("Counter"),
        h.text.children(String(model.count)),
        h.text.style({ dim: true }).children("up/+ increment  down decrement  r reset  enter done"),
      ),
});

const BannerMessage = UiSchema.TaggedEnum({ Ticked: {}, Done: {} });

const Banner = Terminal.component({
  name: "Banner",
  model: Schema.Struct({ ticks: Schema.Finite }),
  message: BannerMessage,
}).make({
  init: () => ({ ticks: 0 }),
  update: {
    Ticked: ($) => $.evolve({ ticks: (n) => n + 1 }),
    Done: ($) => $.run(TerminalCommand.finish()),
  },
  subscriptions: () => [
    TerminalSubscription.shortcuts([
      { key: "+", message: BannerMessage.Ticked() },
      { key: "return", message: BannerMessage.Done() },
    ]),
  ],
  view: (h, model) =>
    h.box.children(
      h.static.children(h.text.children("banner")),
      h.text.children(`ticks ${model.ticks}`),
    ),
});

const Tall = Terminal.component({
  name: "Tall",
  model: Schema.Struct({ count: Schema.Finite }),
  message: BannerMessage,
}).make({
  init: () => ({ count: 0 }),
  update: {
    Ticked: ($) => $.evolve({ count: (n) => n + 1 }),
    Done: ($) => $.run(TerminalCommand.finish()),
  },
  subscriptions: () => [
    TerminalSubscription.shortcuts([
      { key: "+", message: BannerMessage.Ticked() },
      { key: "return", message: BannerMessage.Done() },
    ]),
  ],
  view: (h, model) =>
    h.box.children(
      ...Array.from({ length: 8 }, (_, line) => h.text.children(`L${line} n=${model.count}`)),
    ),
});

const PickerEvents = UiSchema.TaggedEnum({ Picked: { count: Schema.Finite } });

const Picker = Terminal.component({
  name: "Picker",
  model: Schema.Struct({ count: Schema.Finite }),
  message: BannerMessage,
  events: PickerEvents,
}).make({
  init: () => ({ count: 0 }),
  update: {
    Ticked: ($) =>
      $.evolve({ count: (n) => n + 1 }).emit(PickerEvents.Picked({ count: $.model.count + 1 })),
    Done: ($) => $.run(TerminalCommand.finish()),
  },
  subscriptions: () => [
    TerminalSubscription.shortcuts([
      { key: "+", message: BannerMessage.Ticked() },
      { key: "return", message: BannerMessage.Done() },
    ]),
  ],
  view: (h, model) => h.text.children(`picked ${model.count}`),
});

const Broken = Terminal.component({
  name: "Broken",
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Never: {} }),
}).make({
  init: () => ({}),
  update: { Never: ($) => $.model },
  view: () => {
    throw new Error("view failed");
  },
});

const withTerminal = <A, E>(
  body: (terminal: TerminalTest.TestTerminal) => Effect.Effect<A, E>,
  size = { columns: 80, rows: 12 },
) => TerminalTest.withTestTerminal(size, body);

const showing = (text: string) => (rows: ReadonlyArray<string>) =>
  rows.some((row) => row.includes(text));

const countIs = (count: number) => (rows: ReadonlyArray<string>) => rows.includes(String(count));

describe("inline run on a headless terminal", () => {
  it.effect("draws below earlier output, follows keys and returns the model on finish", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        t.terminal.write("$ echo hi\r\nhi\r\n");
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Counter, {}));

        const drawn = yield* t.untilScreen(countIs(0));
        expect(drawn.slice(0, 4)).toEqual(["$ echo hi", "hi", "Counter", "0"]);

        yield* t.type("++\u001b[A");
        yield* t.untilScreen(countIs(3));
        yield* t.type("\u001b[B");
        yield* t.untilScreen(countIs(2));
        yield* t.type("r");
        yield* t.untilScreen(countIs(0));
        yield* t.type("+\r");

        expect(yield* Fiber.join(fiber)).toMatchObject({ count: 1 });
      }),
    ),
  );

  it.effect("keeps the final frame in the scrollback with the cursor below it", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        t.terminal.write("$ run\r\n");
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Counter, {}));
        yield* t.untilScreen(countIs(0));
        yield* t.type("+++");
        yield* t.untilScreen(countIs(3));
        yield* t.type("\r");
        yield* Fiber.join(fiber);

        expect((yield* t.scrollback).slice(0, 4)).toEqual([
          "$ run",
          "Counter",
          "3",
          expect.stringContaining("enter done"),
        ]);
        expect(yield* t.cursor).toEqual({ x: 0, y: 4 });
        expect(yield* t.rawModeTransitions).toEqual([true, false]);
        expect(yield* t.listeners).toEqual({ data: 0, resize: 0 });
      }),
    ),
  );

  it.effect("interrupts on the Ctrl+C byte, keeps the last frame and restores the terminal", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        t.terminal.write("$ run\r\n");
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Counter, {}));
        yield* t.untilScreen(countIs(0));
        yield* t.type("+");
        yield* t.untilScreen(countIs(1));
        yield* t.type("\u0003");

        const exit = yield* Fiber.await(fiber);
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(yield* t.rawModeTransitions).toEqual([true, false]);
        expect((yield* t.scrollback).slice(0, 3)).toEqual(["$ run", "Counter", "1"]);
        expect(yield* t.cursor).toEqual({ x: 0, y: 4 });
      }),
    ),
  );

  it.effect("fails the run with the view's error and restores the terminal", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Broken, {}));

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          message: "view failed",
        });
        expect(Exit.hasInterrupts(exit)).toBe(false);
        expect(yield* t.rawModeTransitions).toEqual([true, false]);
      }),
    ),
  );

  it.effect("hands the root's typed events to onEmit in emission order", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        const picked: Array<number> = [];
        const fiber = yield* TerminalTest.startOn(
          t,
          TerminalHost.run(
            Picker,
            {},
            {
              onEmit: (event) => {
                if (event._tag === "Picked") picked.push(event.count);
              },
            },
          ),
        );
        yield* t.untilScreen(showing("picked 0"));
        yield* t.type("++");
        yield* t.untilScreen(showing("picked 2"));
        yield* t.type("\r");
        yield* Fiber.join(fiber);

        expect(picked).toEqual([1, 2]);
      }),
    ),
  );

  it.effect("keeps the fallback frame on screen when the view crashes", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        t.terminal.write("$ run\r\n");
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Broken, {}));
        yield* Fiber.await(fiber);

        expect((yield* t.scrollback).slice(0, 2)).toEqual(["$ run", "The view failed."]);
        expect(yield* t.cursor).toEqual({ x: 0, y: 2 });
      }),
    ),
  );

  it.effect("writes static content to the scrollback once while the live region updates", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Banner, {}));
        yield* t.untilScreen(showing("ticks 0"));
        yield* t.type("+");
        yield* t.untilScreen(showing("ticks 1"));
        yield* t.type("+");
        const rows = yield* t.untilScreen(showing("ticks 2"));
        expect(rows.filter((row) => row === "banner")).toHaveLength(1);

        yield* t.type("\r");
        yield* Fiber.join(fiber);
        const lines = yield* t.scrollback;
        expect(lines.filter((row) => row === "banner")).toHaveLength(1);
        expect(lines.filter((row) => row.startsWith("ticks"))).toEqual(["ticks 2"]);
      }),
    ),
  );

  it.effect("relays the frame out when the terminal narrows below it and leaves one frame", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        t.terminal.write("$ run\r\n");
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Counter, {}));
        yield* t.untilScreen(countIs(0));

        yield* t.resize({ columns: 24, rows: 12 });
        const rows = yield* t.untilScreen(showing("up/+ increment"));
        expect(rows.slice(0, 6)).toEqual([
          "$ run",
          "Counter",
          "0",
          "up/+ increment  down",
          "decrement  r reset",
          "enter done",
        ]);
        expect(rows.filter((row) => row === "Counter")).toHaveLength(1);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("relays the frame out when the terminal widens and leaves one frame", () =>
    withTerminal(
      (t) =>
        Effect.gen(function* () {
          const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Counter, {}));
          yield* t.untilScreen(showing("decrement  r reset"));

          yield* t.resize({ columns: 60, rows: 12 });
          const rows = yield* t.untilScreen(showing("enter done"));
          expect(rows.slice(0, 3)).toEqual([
            "Counter",
            "0",
            "up/+ increment  down decrement  r reset  enter done",
          ]);
          expect(rows.filter((row) => row === "Counter")).toHaveLength(1);
          yield* Fiber.interrupt(fiber);
        }),
      { columns: 24, rows: 12 },
    ),
  );

  it.effect("leaves one clean copy of a frame taller than the terminal", () =>
    withTerminal(
      (t) =>
        Effect.gen(function* () {
          t.terminal.write("$ run\r\n");
          const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Tall, {}));
          yield* t.untilScreen(showing("n=0"));
          yield* t.type("++");
          yield* t.untilScreen(showing("n=2"));
          yield* t.type("\r");
          yield* Fiber.join(fiber);

          expect((yield* t.scrollback).slice(0, 9)).toEqual([
            "$ run",
            ...Array.from({ length: 8 }, (_, line) => `L${line} n=2`),
          ]);
          expect(yield* t.cursor).toEqual({ x: 0, y: 5 });
        }),
      { columns: 30, rows: 6 },
    ),
  );

  it.effect("holds a lone Escape until the escape timeout, then delivers it as a key", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Counter, {}));
        yield* t.untilScreen(countIs(0));

        yield* t.type("\u001b");
        expect(yield* t.screenText).toSatisfy(countIs(0));

        yield* TestClock.adjust("49 millis");
        expect(yield* t.screenText).toSatisfy(countIs(0));

        yield* TestClock.adjust("1 millis");
        yield* t.untilScreen(countIs(-1));
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("disposes the host and restores stdin when the final frame cannot be written", () =>
    withTerminal((t) =>
      Effect.gen(function* () {
        let broken = false;
        const failing = {
          ...t.terminal,
          write: (bytes: string) => {
            if (broken) throw new Error("write EPIPE");
            t.terminal.write(bytes);
          },
        };
        const fiber = yield* Effect.forkChild(
          TerminalHost.run(Counter, {}).pipe(
            Effect.provideService(TerminalHost.Transport, failing),
          ),
        );
        yield* t.untilScreen(countIs(0));

        broken = true;
        yield* Fiber.interrupt(fiber);

        expect(yield* t.listeners).toEqual({ data: 0, resize: 0 });
        expect(yield* t.rawModeTransitions).toEqual([true, false]);
      }),
    ),
  );

  it.effect("follows keys and resizes sent through the test events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* TerminalTest.mount(Counter, {}, { columns: 40, rows: 12 });
        const events = TestTerminalEvents.layer.pipe(
          Layer.provide(Layer.succeed(TerminalTest.TestTerminal, app.terminal)),
        );
        yield* app.terminal.untilScreen(countIs(0));

        yield* app.pressKey("up");
        yield* TestTerminalEvents.pressKey("+").pipe(Effect.provide(events));
        yield* app.terminal.untilScreen(countIs(2));

        yield* TestTerminalEvents.resize(24, 12).pipe(Effect.provide(events));
        const rows = yield* app.terminal.untilScreen(showing("decrement  r reset"));
        expect(rows.filter((row) => row === "Counter")).toHaveLength(1);
        expect(rows).toContain("2");
      }),
    ),
  );
});

describe("mounted component", () => {
  const mountCounter = TerminalTest.mount(Counter, {}, { columns: 60, rows: 12 });

  it.effect(
    "resolves finished with the model and keeps the frame when the component finishes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* mountCounter;
          yield* app.terminal.untilScreen(countIs(0));
          yield* app.pressKey("+");
          yield* app.terminal.untilScreen(countIs(1));
          yield* app.pressKey("return");

          expect(yield* app.finished).toMatchObject({ count: 1 });
          expect((yield* app.terminal.scrollback).slice(0, 3)).toEqual([
            "Counter",
            "1",
            expect.stringContaining("enter done"),
          ]);
          expect(yield* app.terminal.cursor).toEqual({ x: 0, y: 3 });
        }),
      ),
  );

  it.effect("interrupts `finished` when it is awaited after the scope has closed", () =>
    Effect.gen(function* () {
      const app = yield* Effect.scoped(
        Effect.gen(function* () {
          const mounted = yield* mountCounter;
          yield* mounted.terminal.untilScreen(countIs(0));
          return mounted;
        }),
      );

      expect(Exit.hasInterrupts(yield* Effect.exit(app.finished))).toBe(true);
    }),
  );

  it.effect("interrupts the fiber that mounted on the Ctrl+C byte and restores the terminal", () =>
    Effect.gen(function* () {
      const mounted = yield* Deferred.make<Effect.Success<typeof mountCounter>>();
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* mountCounter;
            yield* Deferred.succeed(mounted, app);
            return yield* Effect.never;
          }),
        ),
      );
      const app = yield* Deferred.await(mounted);
      yield* app.terminal.untilScreen(countIs(0));

      yield* app.pressKey("c", { ctrl: true });

      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(yield* app.terminal.rawModeTransitions).toEqual([true, false]);
      expect(yield* app.terminal.listeners).toEqual({ data: 0, resize: 0 });
    }),
  );
});
