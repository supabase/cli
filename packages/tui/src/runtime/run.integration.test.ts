import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Subscription from "foldkit/subscription";

import * as Terminal from "../terminal/terminal.ts";
import { TestTerminal } from "../terminal/testing.ts";
import { screen } from "../view/screen.ts";
import { text } from "../view/view.ts";
import {
  dropTrailingBlank,
  expectCursorVisible,
  frame,
  nextFrame,
  shown,
  startScripted,
  withTerminal,
  Written,
} from "./test-support.ts";
import { makeProgram, run } from "./run.ts";

type CountMessage = { readonly _tag: "Bump" } | { readonly _tag: "Leave" };

describe("Tui.run rendering", () => {
  it.effect("does not render again when an update leaves the model equal", () =>
    withTerminal(
      Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<CountMessage>();
        const settled = yield* Queue.unbounded<void>();
        let views = 0;
        const running = yield* run(
          makeProgram({
            Model: Schema.Struct({ count: Schema.Finite }),
            init: () => ({ model: { count: 0 } }),
            update: (model, message: CountMessage) => ({
              model: message._tag === "Bump" ? { count: model.count + 1 } : { ...model },
            }),
            view: (model) => {
              views += 1;
              return screen(text(`count ${model.count}`));
            },
            subscriptions: Subscription.make<{ readonly count: number }, CountMessage>()(() => ({
              inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
            })),
            result: (model) => {
              Queue.offerUnsafe(settled, undefined);
              return model.count >= 2 ? Option.some("done") : Option.none();
            },
          }),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        const written = yield* Written;
        yield* written.next;
        yield* Queue.take(settled);
        expect(views).toBe(1);

        yield* Queue.offer(inbox, { _tag: "Bump" });
        yield* Queue.take(settled);
        yield* nextFrame;
        expect(views).toBe(2);

        yield* Queue.offer(inbox, { _tag: "Leave" });
        yield* Queue.take(settled);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("16 millis");
        yield* Effect.yieldNow;
        expect(views).toBe(2);

        yield* Queue.offer(inbox, { _tag: "Bump" });
        yield* Fiber.join(running);
        expect(yield* shown).toEqual(["count 2"]);
      }),
    ),
  );

  it.effect("redraws the frame in place and returns the program result", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const { inbox, running } = yield* startScripted;
        expect(yield* shown).toEqual(["starting"]);

        yield* Queue.offer(inbox, frame(["working 1/2", "detail"]));
        yield* nextFrame;
        expect(yield* shown).toEqual(["working 1/2", "detail"]);
        expect(yield* test.cursor).toEqual({ x: 0, y: 2 });

        yield* Queue.offer(inbox, frame(["finished"], { done: true }));
        expect(yield* Fiber.join(running)).toBe("done");
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual(["finished"]);
        expect(yield* test.cursor).toEqual({ x: 0, y: 1 });
      }),
    ),
  );

  it.effect("keeps committed entries above the live region in commit order", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const terminal = yield* Terminal.Service;
        const { inbox, running } = yield* startScripted;

        yield* Queue.offer(inbox, frame(["live 1"], { committed: ["first"] }));
        yield* nextFrame;
        expect(yield* shown).toEqual(["first", "live 1"]);

        yield* Queue.offer(inbox, frame(["live 2"], { committed: ["first", "second"] }));
        yield* nextFrame;
        expect(yield* shown).toEqual(["first", "second", "live 2"]);

        yield* Queue.offer(
          inbox,
          frame(["final"], { committed: ["first", "second", "third"], done: true }),
        );
        yield* Fiber.join(running);
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual([
          "first",
          "second",
          "third",
          "final",
        ]);

        yield* terminal.write("after\r\n");
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual([
          "first",
          "second",
          "third",
          "final",
          "after",
        ]);
      }),
    ),
  );

  it.effect("fails the run when a committed entry disappears between frames", () =>
    withTerminal(
      Effect.gen(function* () {
        const { inbox, running } = yield* startScripted;
        yield* Queue.offer(inbox, frame(["live"], { committed: ["first", "second"] }));
        yield* nextFrame;

        yield* Queue.offer(inbox, frame(["live"], { committed: ["first"] }));
        yield* TestClock.adjust("16 millis");

        const exit = yield* Fiber.await(running);
        expect(Exit.hasDies(exit)).toBe(true);
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect("draws only the bottom of a tall live region and the whole of it at finish", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const { inbox, running } = yield* startScripted;
        const lines = Array.from(
          { length: 15 },
          (_, index) => `line ${String(index + 1).padStart(2, "0")}`,
        );

        yield* Queue.offer(inbox, frame(lines));
        yield* nextFrame;
        expect(yield* test.screenText).toEqual([...lines.slice(6), ""]);
        expect(yield* test.cursor).toEqual({ x: 0, y: 9 });

        yield* Queue.offer(inbox, frame(lines, { done: true }));
        yield* Fiber.join(running);
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual(lines);
      }),
      { columns: 40, rows: 10 },
    ),
  );

  it.effect("lays lines out one column short of the width so none wraps", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const { inbox } = yield* startScripted;
        const full = ["a", "b", "c"].map((letter) => letter.repeat(19));

        yield* Queue.offer(inbox, frame([...full, text("z".repeat(40), { wrap: false })]));
        yield* nextFrame;
        const lines = yield* shown;
        expect(lines.slice(0, 3)).toEqual(full);
        expect(lines).toHaveLength(4);
        expect(lines[3]?.length).toBeLessThanOrEqual(19);
        expect(yield* test.cursor).toEqual({ x: 0, y: 4 });
      }),
      { columns: 20, rows: 24 },
    ),
  );
});
