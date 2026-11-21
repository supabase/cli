import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import type * as Command from "foldkit/command";
import * as Subscription from "foldkit/subscription";
import type * as Update from "foldkit/update";

import * as Terminal from "../terminal/terminal.ts";
import { TestTerminal } from "../terminal/testing.ts";
import { screen } from "../view/screen.ts";
import { text } from "../view/view.ts";
import { keys, type Keys } from "./keys.ts";
import { makeProgram, run } from "./run.ts";
import { keyProgram, shown, withTerminal, Written } from "./test-support.ts";

type WatchMessage =
  | { readonly _tag: "Set"; readonly n: number }
  | { readonly _tag: "Touch" }
  | { readonly _tag: "Finish" };

const WatchModel = Schema.Struct({
  n: Schema.Finite,
  touches: Schema.Finite,
  done: Schema.Boolean,
});
type WatchModel = typeof WatchModel.Type;

/** `watched` depends on `n` alone; every start and stop of its stream lands in `events`. */
const watching = (
  inbox: Queue.Dequeue<WatchMessage>,
  events: Array<string>,
  started: Queue.Enqueue<number>,
) =>
  makeProgram({
    Model: WatchModel,
    init: () => ({ model: { n: 0, touches: 0, done: false } }),
    update: (model, message) =>
      Match.value(message).pipe(
        Match.tagsExhaustive({
          Set: ({ n }) => ({ model: { ...model, n } }),
          Touch: () => ({ model: { ...model, touches: model.touches + 1 } }),
          Finish: () => ({ model: { ...model, done: true } }),
        }),
      ),
    view: (model) => screen(text(`n=${model.n} touches=${model.touches}`)),
    subscriptions: Subscription.make<WatchModel, WatchMessage>()((entry) => ({
      inbox: Subscription.persistentEntry(Stream.fromQueue(inbox)),
      watched: entry(
        { n: Schema.Finite },
        {
          modelToDependencies: (model) => ({ n: model.n }),
          dependenciesToStream: ({ n }) =>
            Stream.unwrap(
              Effect.sync(() => events.push(`start:${n}`)).pipe(
                Effect.andThen(Queue.offer(started, n)),
                Effect.as(Stream.never),
              ),
            ).pipe(Stream.ensuring(Effect.sync(() => events.push(`stop:${n}`)))),
        },
      ),
    })),
    result: (model) => (model.done ? Option.some("done") : Option.none()),
  });

const SpinnerModel = Schema.Struct({ ticks: Schema.Finite });
type SpinnerModel = typeof SpinnerModel.Type;

interface Tick {
  readonly _tag: "Tick";
}

/** Reads no keys: it ticks on the clock and finishes on the third tick. */
const spinner = makeProgram({
  Model: SpinnerModel,
  init: () => ({ model: { ticks: 0 } }),
  update: (model) => ({ model: { ticks: model.ticks + 1 } }),
  view: (model) => screen(text(`tick ${model.ticks}`)),
  subscriptions: Subscription.make<SpinnerModel, Tick>()(() => ({
    tick: Subscription.persistentEntry(
      Stream.tick("100 millis").pipe(Stream.map((): Tick => ({ _tag: "Tick" }))),
    ),
  })),
  result: (model) => (model.ticks >= 3 ? Option.some(model.ticks) : Option.none()),
});

type PressMessage = { readonly _tag: "Hold" } | { readonly _tag: "Restart" };

/**
 * One subscription restarts on every key; another holds stdin throughout, so a restart never
 * drops the claim. `restarted` fires when the replacement stream starts.
 */
const restartingBesideHolder = (restarted: Deferred.Deferred<void>) =>
  makeProgram({
    Model: Schema.Struct({ n: Schema.Finite }),
    init: () => ({ model: { n: 0 } }),
    update: (model, message) => ({
      model: message._tag === "Restart" ? { n: model.n + 1 } : model,
    }),
    view: (model) => screen(text(`restarts ${model.n}`)),
    subscriptions: Subscription.make<{ readonly n: number }, PressMessage, Keys>()((entry) => ({
      hold: Subscription.persistentEntry(Stream.map(keys, (): PressMessage => ({ _tag: "Hold" }))),
      restart: entry(
        { n: Schema.Finite },
        {
          modelToDependencies: (model) => ({ n: model.n }),
          dependenciesToStream: ({ n }) =>
            Stream.unwrap(
              Effect.as(
                n === 0 ? Effect.void : Deferred.succeed(restarted, undefined),
                Stream.map(keys, (): PressMessage => ({ _tag: "Restart" })),
              ),
            ),
        },
      ),
    })),
    result: () => Option.none(),
  });

class Greeter extends Context.Service<Greeter, { readonly greeting: string }>()("test/Greeter") {}
class Tally extends Context.Service<Tally, { readonly total: number }>()("test/Tally") {}

type ServiceMessage =
  | { readonly _tag: "Greeted"; readonly greeting: string }
  | { readonly _tag: "Tallied"; readonly total: number }
  | { readonly _tag: "PressedAny" };

const ServiceModel = Schema.Struct({ greeting: Schema.String, total: Schema.Finite });
type ServiceModel = typeof ServiceModel.Type;

const greet: Command.Command<ServiceMessage, never, Greeter> = {
  name: "Greet",
  effect: Effect.map(Effect.service(Greeter), ({ greeting }): ServiceMessage => ({
    _tag: "Greeted",
    greeting,
  })),
};

const tally: Command.Command<ServiceMessage, never, Tally> = {
  name: "Tally",
  effect: Effect.map(Effect.service(Tally), ({ total }): ServiceMessage => ({
    _tag: "Tallied",
    total,
  })),
};

const serviceView = (model: ServiceModel) => screen(text(`${model.greeting} ${model.total}`));

/** Only a Command in `init` needs a service; nothing reads keys. */
const greetingOnStart = makeProgram({
  Model: ServiceModel,
  init: () => ({ model: { greeting: "", total: 0 }, commands: [greet] }),
  update: (model, message: ServiceMessage): Update.Return<ServiceModel, ServiceMessage> => ({
    model: message._tag === "Greeted" ? { ...model, greeting: message.greeting } : model,
  }),
  view: serviceView,
  result: (model) => (model.greeting === "" ? Option.none() : Option.some(model.greeting)),
});

/** `init` and `update` need different services and the subscription reads keys. */
const twoServicesAndKeys = makeProgram({
  Model: ServiceModel,
  init: () => ({ model: { greeting: "", total: 0 }, commands: [greet] }),
  update: (model, message: ServiceMessage): Update.Return<ServiceModel, ServiceMessage, Tally> => ({
    model: message._tag === "Tallied" ? { ...model, total: message.total } : model,
    commands: message._tag === "Greeted" ? [tally] : undefined,
  }),
  view: serviceView,
  subscriptions: Subscription.make<ServiceModel, ServiceMessage, Keys>()(() => ({
    keys: Subscription.persistentEntry(
      Stream.map(keys, (): ServiceMessage => ({ _tag: "PressedAny" })),
    ),
  })),
  result: () => Option.none<string>(),
});

describe("Tui.run subscriptions", () => {
  it.effect("restarts a stream when its dependencies change and keeps it when they do not", () =>
    withTerminal(
      Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<WatchMessage>();
        const started = yield* Queue.unbounded<number>();
        const events: Array<string> = [];
        const running = yield* run(watching(inbox, events, started)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        expect(yield* Queue.take(started)).toBe(0);

        yield* Queue.offer(inbox, { _tag: "Touch" });
        yield* Queue.offer(inbox, { _tag: "Set", n: 1 });
        expect(yield* Queue.take(started)).toBe(1);

        yield* Queue.offer(inbox, { _tag: "Finish" });
        expect(yield* Fiber.join(running)).toBe("done");

        expect(events).toEqual(["start:0", "stop:0", "start:1", "stop:1"]);
        expect(yield* shown).toEqual(["n=1 touches=1"]);
      }),
    ),
  );

  it.effect(
    "releases stdin once, without re-entering raw mode, when Ctrl+C follows a restart",
    () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const written = yield* Written;
          const restarted = yield* Deferred.make<void>();
          const running = yield* run(restartingBesideHolder(restarted)).pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* written.next;
          yield* test.type("a");
          yield* Deferred.await(restarted);

          yield* test.type("\x03");

          expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
          expect(yield* test.rawModeTransitions).toEqual([true, false]);
          expect(yield* test.inputState).toEqual({ paused: true, raw: false, listenerCount: 0 });
        }),
      ),
  );

  it.effect("never touches raw mode for a program that reads no keys", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* run(spinner).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;

        yield* TestClock.adjust("300 millis");

        expect(yield* Fiber.join(running)).toBe(3);
        expect(yield* shown).toEqual(["tick 3"]);
        expect(yield* test.rawModeTransitions).toEqual([]);
        expect(yield* test.inputState).toEqual({ paused: true, raw: false, listenerCount: 0 });
      }),
    ),
  );

  it.effect("gives the services provided to run to the Commands of init and update", () =>
    withTerminal(
      Effect.gen(function* () {
        const running = yield* run(greetingOnStart).pipe(
          Effect.provide(Layer.succeed(Greeter, { greeting: "hello" })),
          Effect.forkScoped({ startImmediately: true }),
        );

        expect(yield* Fiber.join(running)).toBe("hello");
      }),
    ),
  );

  it("asks callers for the services programs need, never for the run's own key service", () => {
    expectTypeOf(run(spinner)).toEqualTypeOf<
      Effect.Effect<number, Terminal.TerminalError, Terminal.Service>
    >();
    expectTypeOf(run(keyProgram())).toEqualTypeOf<
      Effect.Effect<string, Terminal.TerminalError, Terminal.Service>
    >();
    expectTypeOf(run(greetingOnStart)).toEqualTypeOf<
      Effect.Effect<string, Terminal.TerminalError, Greeter | Terminal.Service>
    >();
    expectTypeOf(run(twoServicesAndKeys)).toEqualTypeOf<
      Effect.Effect<string, Terminal.TerminalError, Greeter | Tally | Terminal.Service>
    >();
  });

  it("refuses an update that returns a child OutMessage the root would drop", () => {
    const withOutMessage = (): Update.ReturnWithOutMessage<number, ServiceMessage, string> => ({
      model: 1,
    });
    const program = makeProgram({
      Model: Schema.Finite,
      init: () => ({ model: 0 }),
      // @ts-expect-error a root program has no parent to receive the OutMessage
      update: withOutMessage,
      view: () => screen(text("")),
      result: () => Option.none<string>(),
    });

    expect(program.init().model).toBe(0);
  });
});
