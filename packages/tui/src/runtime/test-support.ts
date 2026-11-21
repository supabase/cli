import { expect } from "@effect/vitest";
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import type * as Update from "foldkit/update";
import * as Subscription from "foldkit/subscription";

import * as Terminal from "../terminal/terminal.ts";
import { layerTest, TestTerminal, type TestTerminalOptions } from "../terminal/testing.ts";
import type { Node } from "../view/node.ts";
import { screen } from "../view/screen.ts";
import { column, text } from "../view/view.ts";
import { Key } from "../terminal/key.ts";
import { keys, type Keys } from "./keys.ts";
import { makeProgram, run } from "./run.ts";

export interface WrittenInterface {
  /** Resolves with the bytes of the next write the emulator has fully processed. */
  readonly next: Effect.Effect<string>;
  /** Resolves with the bytes of the next write handed to the terminal, completed or not. */
  readonly nextSubmitted: Effect.Effect<string>;
  /** Every write handed to the terminal so far, in order. */
  readonly submitted: Effect.Effect<ReadonlyArray<string>>;
  /** Forgets the completions of writes made so far, so the next `next` waits for a new write. */
  readonly discard: Effect.Effect<void>;
}

export class Written extends Context.Service<Written, WrittenInterface>()(
  "@supabase/tui/test/Written",
) {}

/** The test terminal with a completion signal per accepted write, so tests wait instead of sleeping. */
const layerObserved = (options: TestTerminalOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Layer.build(layerTest(options));
      const terminal = Context.get(context, Terminal.Service);
      const completed = yield* Queue.unbounded<string>();
      const submissions = yield* Queue.unbounded<string>();
      const submitted: Array<string> = [];
      const observed = Terminal.Service.of({
        ...terminal,
        write: (bytes) =>
          Effect.sync(() => {
            submitted.push(bytes);
            Queue.offerUnsafe(submissions, bytes);
          }).pipe(
            Effect.andThen(terminal.write(bytes)),
            Effect.tap(() => Queue.offer(completed, bytes)),
          ),
      });
      return context.pipe(
        Context.add(Terminal.Service, observed),
        Context.add(
          Written,
          Written.of({
            next: Queue.take(completed),
            nextSubmitted: Queue.take(submissions),
            submitted: Effect.sync(() => [...submitted]),
            discard: Effect.asVoid(Queue.clear(completed)),
          }),
        ),
      );
    }),
  );

export const withTerminal = <A, E>(
  body: Effect.Effect<A, E, Scope.Scope | Terminal.Service | TestTerminal | Written>,
  options: Partial<TestTerminalOptions> = {},
) => body.pipe(Effect.scoped, Effect.provide(layerObserved({ columns: 80, rows: 24, ...options })));

/** A whole model, delivered as the message that replaces it. */
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "_tag" in value;

export const Frame = Schema.Struct({
  live: Schema.Array(Schema.Union([Schema.String, Schema.declare(isNode)])),
  committed: Schema.Array(Schema.String),
  done: Schema.Boolean,
});
export type Frame = typeof Frame.Type;

const initialFrame: Frame = { live: ["starting"], committed: [], done: false };

const viewFrame = (model: Frame) =>
  screen(
    column(model.live.map((line) => (typeof line === "string" ? text(line) : line))),
    model.committed.map((line) => text(line)),
  );

export const frame = (live: ReadonlyArray<string | Node>, rest: Partial<Frame> = {}): Frame => ({
  live,
  committed: [],
  done: false,
  ...rest,
});

interface FrameMessage {
  readonly _tag: "OfferedFrame";
  readonly frame: Frame;
}

/** A program whose model is whatever the test offers to `inbox`, starting at `initial`; it finishes with "done". */
export const scripted = (inbox: Queue.Dequeue<Frame>, initial: Frame = initialFrame) =>
  makeProgram({
    Model: Frame,
    init: () => ({ model: initial }),
    update: (_, message: FrameMessage) => ({ model: message.frame }),
    view: viewFrame,
    subscriptions: Subscription.make<Frame, FrameMessage>()(() => ({
      inbox: Subscription.persistentEntry(
        Stream.fromQueue(inbox).pipe(
          Stream.map((frame): FrameMessage => ({ _tag: "OfferedFrame", frame })),
        ),
      ),
    })),
    result: (model) => (model.done ? Option.some("done") : Option.none()),
  });

/** A model together with the Commands its update starts. */
export interface Directive {
  readonly _tag: "Directed";
  readonly frame: Frame;
  readonly commands: Update.Commands<Directive>;
}

/** Like `scripted`, but each offered message also names the Commands its update starts. */
export const directed = (inbox: Queue.Dequeue<Directive>) =>
  makeProgram({
    Model: Frame,
    init: () => ({ model: initialFrame }),
    update: (_, message) => ({ model: message.frame, commands: message.commands }),
    view: viewFrame,
    subscriptions: Subscription.make<Frame, Directive>()(() => ({
      inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
    })),
    result: (model) => (model.done ? Option.some("done") : Option.none()),
  });

export interface KeyMessage {
  readonly _tag: "PressedKey";
  readonly key: Key;
}

const KeyModel = Schema.Struct({ pressed: Schema.Array(Schema.String), quit: Schema.Boolean });
export type KeyModel = typeof KeyModel.Type;

const describeBareKey = (key: Key): string =>
  Key.matchOrElse(
    key,
    { Char: ({ text }) => text, Ctrl: ({ letter }) => `Ctrl+${letter}` },
    () => key._tag,
  );

const describeKey = (key: Key): string =>
  "meta" in key && key.meta === true ? `Meta+${describeBareKey(key)}` : describeBareKey(key);

/** Lists the keys it receives and finishes with "stopped" on `q`; reading keys is what claims stdin. */
export const keyProgram = (start: { readonly commands?: Update.Commands<KeyMessage> } = {}) =>
  makeProgram({
    Model: KeyModel,
    init: () => ({ model: { pressed: [], quit: false }, ...start }),
    update: (model, message) => ({
      model: {
        pressed: [...model.pressed, describeKey(message.key)],
        quit: message.key._tag === "Char" && message.key.text === "q",
      },
    }),
    view: (model) => screen(text(["keys:", ...model.pressed].join(" "))),
    subscriptions: Subscription.make<KeyModel, KeyMessage, Keys>()(() => ({
      keys: Subscription.persistentEntry(
        Stream.map(keys, (key): KeyMessage => ({ _tag: "PressedKey", key })),
      ),
    })),
    result: (model) => (model.quit ? Option.some("stopped") : Option.none()),
  });

export const dropTrailingBlank = (lines: ReadonlyArray<string>) => {
  const end = lines.findLastIndex((line) => line !== "");
  return lines.slice(0, end + 1);
};

const hideCursor = "\u001b[?25l";
const showCursor = "\u001b[?25h";

/** Asserts the cursor was hidden for a live frame and shown again afterwards. */
export const expectCursorVisible = Effect.gen(function* () {
  const test = yield* TestTerminal;
  const bytes = yield* test.rawBytes;
  expect(bytes.lastIndexOf(hideCursor)).toBeGreaterThanOrEqual(0);
  expect(bytes.lastIndexOf(showCursor)).toBeGreaterThan(bytes.lastIndexOf(hideCursor));
});

/** Releases the render throttle, then waits for the frame it lets through to reach the emulator. */
export const nextFrame = Effect.gen(function* () {
  const written = yield* Written;
  yield* TestClock.adjust("16 millis");
  return yield* written.next;
});

/** The visible rows without the blank ones below the cursor. */
export const shown = Effect.gen(function* () {
  const test = yield* TestTerminal;
  return dropTrailingBlank(yield* test.screenText);
});

/** Starts a scripted run and returns once its first frame is on screen. */
export const startScripted = Effect.gen(function* () {
  const written = yield* Written;
  const inbox = yield* Queue.unbounded<Frame>();
  const running = yield* run(scripted(inbox)).pipe(Effect.forkScoped({ startImmediately: true }));
  yield* written.next;
  return { inbox, running };
});
