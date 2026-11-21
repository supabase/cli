import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Subscription from "foldkit/subscription";

import * as Terminal from "../terminal/terminal.ts";
import { TestTerminal } from "../terminal/testing.ts";
import { screen } from "../view/screen.ts";
import { column, text } from "../view/view.ts";
import { makeProgram, run } from "./run.ts";
import {
  dropTrailingBlank,
  frame,
  nextFrame,
  shown,
  startScripted,
  withTerminal,
  Written,
} from "./test-support.ts";

const keycap = "1\u{FE0F}\u{20E3}";
const technologist = "\u{1F469}\u{200D}\u{1F4BB}";

interface Finish {
  readonly _tag: "Finish";
}

const finish: Finish = { _tag: "Finish" };

/** Finishes on the first message it receives; its view shows the viewport it was rendered for. */
const finishesOnMessage = (inbox: Queue.Dequeue<Finish>) =>
  makeProgram({
    Model: Schema.Boolean,
    init: () => ({ model: false }),
    update: () => ({ model: true }),
    view: (_, viewport) => screen(text(`${viewport.columns}x${viewport.rows}`)),
    subscriptions: Subscription.make<boolean, Finish>()(() => ({
      inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
    })),
    result: (done) => (done ? Option.some("done") : Option.none()),
  });

/** Finishes on the first message it receives; its view fills the viewport width with one line. */
const fillsViewportWidth = (inbox: Queue.Dequeue<Finish>) =>
  makeProgram({
    Model: Schema.Boolean,
    init: () => ({ model: false }),
    update: () => ({ model: true }),
    view: (_, { columns }) => screen(text("x".repeat(columns))),
    subscriptions: Subscription.make<boolean, Finish>()(() => ({
      inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
    })),
    result: (done) => (done ? Option.some("done") : Option.none()),
  });

interface Bump {
  readonly _tag: "Bump";
}

/** Counts bumps and shows the count beside the viewport it was rendered for. */
const countsBumps = (inbox: Queue.Dequeue<Bump>, updated: Queue.Enqueue<void>) =>
  makeProgram({
    Model: Schema.Finite,
    init: () => ({ model: 0 }),
    update: (count) => ({ model: count + 1 }),
    view: (count, viewport) =>
      screen(text(`count ${count} at ${viewport.columns}x${viewport.rows}`)),
    subscriptions: Subscription.make<number, Bump>()(() => ({
      inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
    })),
    result: () => {
      Queue.offerUnsafe(updated, undefined);
      return Option.none();
    },
  });

/** An idle program whose view shows the viewport it was rendered for. */
const showsViewport = makeProgram({
  Model: Schema.Null,
  init: () => ({ model: null }),
  update: (model) => ({ model }),
  view: (_, viewport) =>
    screen(column([text(`${viewport.columns}x${viewport.rows}`), text("status")]), [
      text("step one"),
    ]),
  result: () => Option.none(),
});

describe("Tui.run geometry", () => {
  describe.each([
    {
      name: "keycaps",
      glyph: keycap,
      rows: [`abcdefg${keycap}`, keycap],
    },
    {
      name: "ZWJ emoji",
      glyph: technologist,
      rows: ["abcdefg", `${technologist}${technologist}`],
    },
  ])("a line of $name at 10 columns", ({ glyph, rows }) => {
    it.effect("occupies two cells in the emulator", () =>
      withTerminal(
        Effect.gen(function* () {
          const terminal = yield* Terminal.Service;
          const test = yield* TestTerminal;
          yield* terminal.write(glyph);
          expect((yield* test.cursor).x).toBe(2);
        }),
        { columns: 10, rows: 8 },
      ),
    );

    it.effect("wraps at the layout width without misplacing or overwriting rows", () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const { inbox, running } = yield* startScripted;

          yield* Queue.offer(inbox, frame([`abcdefg${glyph}${glyph}`, "tail"]));
          yield* nextFrame;
          expect(yield* shown).toEqual([...rows, "tail"]);
          expect(yield* test.cursor).toEqual({ x: 0, y: 3 });

          yield* Queue.offer(inbox, frame(["next", `abcdefg${glyph}${glyph}`], { done: true }));
          yield* Fiber.join(running);
          expect(dropTrailingBlank(yield* test.scrollback)).toEqual(["next", ...rows]);
        }),
        { columns: 10, rows: 8 },
      ),
    );
  });

  describe.each([
    { name: "zero-width space", label: "abcdefg\u200Bh\u200Bi" },
    { name: "soft hyphen", label: "abcdefg\u00ADh\u00ADi" },
  ])("a label with a $name at 10 columns", ({ label }) => {
    it.effect("redraws in place without leaving stale rows", () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const { inbox, running } = yield* startScripted;

          yield* Queue.offer(inbox, frame([label, "tail"]));
          yield* nextFrame;
          yield* Queue.offer(inbox, frame(["next"]));
          yield* nextFrame;

          expect(yield* shown).toEqual(["next"]);
          expect(yield* test.cursor).toEqual({ x: 0, y: 1 });
          yield* Fiber.interrupt(running);
        }),
        { columns: 10, rows: 8 },
      ),
    );
  });

  it.effect("starts a new region below the stale rows when the terminal shrinks", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const { inbox, running } = yield* startScripted;

        yield* Queue.offer(inbox, frame(["spinner a", "status a"], { committed: ["step one"] }));
        yield* nextFrame;
        expect(yield* shown).toEqual(["step one", "spinner a", "status a"]);

        yield* test.resize({ columns: 20, rows: 24 });
        const fallback = yield* nextFrame;
        expect(yield* shown).toEqual([
          "step one",
          "spinner a",
          "status a",
          "",
          "spinner a",
          "status a",
        ]);
        expect(fallback).not.toContain("\u001b[J");
        expect(fallback).not.toContain("\u001b[2A");

        yield* Queue.offer(
          inbox,
          frame(["spinner b", "status b"], { committed: ["step one", "step two"] }),
        );
        const anchored = yield* nextFrame;
        expect(yield* shown).toEqual([
          "step one",
          "spinner a",
          "status a",
          "",
          "step two",
          "spinner b",
          "status b",
        ]);
        expect(anchored).toContain("\u001b[2A\u001b[J");

        yield* Queue.offer(
          inbox,
          frame(["end"], { committed: ["step one", "step two"], done: true }),
        );
        yield* Fiber.join(running);
      }),
      { columns: 40, rows: 24 },
    ),
  );

  it.effect("redraws an idle view in place for the new viewport when the terminal only grows", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        yield* run(showsViewport).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;
        expect(yield* shown).toEqual(["step one", "39x23", "status"]);

        yield* test.resize({ columns: 60, rows: 30 });
        const grown = yield* nextFrame;

        expect(yield* shown).toEqual(["step one", "59x29", "status"]);
        expect(grown).toContain("\u001b[2A\u001b[J");
      }),
      { columns: 40, rows: 24 },
    ),
  );

  it.effect("builds the final frame for the viewport sampled once the stalled redraw drains", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const terminal = yield* Terminal.Service;
        const written = yield* Written;
        const inbox = yield* Queue.unbounded<Finish>();
        const inputClosed = yield* Deferred.make<void>();
        const resizeWhenDrained = yield* Ref.make(false);
        const stall = yield* test.stallWrites;
        const running = yield* run(finishesOnMessage(inbox)).pipe(
          Effect.provideService(Terminal.Service, {
            ...terminal,
            openInput: terminal.openInput.pipe(
              Effect.map((session) => ({
                ...session,
                close: session.close.pipe(
                  Effect.tap(() => Deferred.succeed(inputClosed, undefined)),
                ),
              })),
            ),
            write: (bytes) =>
              terminal.write(bytes).pipe(
                Effect.andThen(Ref.getAndSet(resizeWhenDrained, false)),
                Effect.flatMap((armed) =>
                  armed ? test.resize({ columns: 60, rows: 30 }) : Effect.void,
                ),
              ),
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* written.nextSubmitted;

        // The run has finished and let go of input while its first frame is still held; the
        // terminal grows only as that frame drains, so only a sample taken afterwards sees it.
        yield* Queue.offer(inbox, finish);
        yield* Deferred.await(inputClosed);
        yield* Ref.set(resizeWhenDrained, true);
        yield* stall.release;
        yield* Fiber.join(running);

        expect(yield* shown).toEqual(["59x29"]);
      }),
      { columns: 40, rows: 24 },
    ),
  );

  it.effect("renders a redraw queued behind a stalled write for the size it is laid out at", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const inbox = yield* Queue.unbounded<Bump>();
        const updated = yield* Queue.unbounded<void>();
        const stall = yield* test.stallWrites;
        yield* run(countsBumps(inbox, updated)).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.nextSubmitted;
        yield* Queue.take(updated);

        yield* Queue.offer(inbox, { _tag: "Bump" });
        yield* Queue.take(updated);
        yield* TestClock.adjust("16 millis");
        yield* test.resize({ columns: 60, rows: 30 });
        yield* stall.release;
        yield* written.next;
        yield* written.next;

        expect(yield* shown).toEqual(["count 1 at 59x29"]);
      }),
      { columns: 40, rows: 24 },
    ),
  );

  it.effect("gives plain output a viewport as wide as the width it lays out at", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const inbox = yield* Queue.unbounded<Finish>();
        const running = yield* run(fillsViewportWidth(inbox)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );

        yield* Queue.offer(inbox, finish);
        yield* Fiber.join(running);

        expect(yield* test.rawBytes).toBe(`${"x".repeat(50)}\n`);
      }),
      { columns: 50, rows: 12, isTTY: false },
    ),
  );
});
