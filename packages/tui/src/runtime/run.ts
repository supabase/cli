import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Duration } from "effect";
import type * as Command from "foldkit/command";
import type * as Subscription from "foldkit/subscription";
import type * as Update from "foldkit/update";

import { Key } from "../terminal/key.ts";
import * as Terminal from "../terminal/terminal.ts";
import * as Engine from "../view/engine.ts";
import { emptyScreen, type Screen, type Viewport } from "../view/screen.ts";
import { Keys } from "./keys.ts";
import { makeSessionWriter, type ScreenFor } from "./writer.ts";

/**
 * A Foldkit-shaped program; `result` returning `Some` finishes the run with that value. `init`,
 * `update` and `subscriptions` each carry their own service requirements.
 */
export type Program<
  Model,
  Message extends { readonly _tag: string },
  A,
  InitRequirements = never,
  UpdateRequirements = never,
  SubscriptionRequirements = never,
> = Readonly<{
  Model: Schema.Codec<Model, any, unknown, unknown>;
  init: () => Update.Return<Model, Message, InitRequirements>;
  update: (model: Model, message: Message) => Update.Return<Model, Message, UpdateRequirements>;
  view: (model: Model, viewport: Viewport) => Screen;
  subscriptions?: Subscription.Subscriptions<Model, Message, SubscriptionRequirements>;
  result: (model: Model) => Option.Option<A>;
}>;

/**
 * Builds a program for `run`. The three requirement sets are inferred apart, so an `update`
 * annotated with `Update.Return` (requirements `never`) composes with subscriptions that need
 * services.
 */
export const makeProgram = <
  Model,
  Message extends { readonly _tag: string },
  A,
  InitRequirements = never,
  UpdateRequirements = never,
  SubscriptionRequirements = never,
>(
  program: Program<
    Model,
    Message,
    A,
    InitRequirements,
    UpdateRequirements,
    SubscriptionRequirements
  >,
): Program<Model, Message, A, InitRequirements, UpdateRequirements, SubscriptionRequirements> =>
  program;

export interface RunOptions {
  /** Deliver Ctrl+C to the program as a key instead of interrupting the run. */
  readonly handleCtrlC?: boolean;
  /** Interrupt the run on Escape instead of delivering it to the program. */
  readonly interruptOnEscape?: boolean;
  /** Minimum time between rendered frames; defaults to 16 milliseconds. */
  readonly frameInterval?: Duration.Input;
}

interface Finished<Model, A> {
  readonly model: Model;
  readonly value: A;
}

interface FollowedSubscription<Model> {
  readonly modelToDependencies: (model: Model) => unknown;
  readonly equivalence: (a: unknown, b: unknown) => boolean;
  readonly restarts: Queue.Queue<unknown>;
  latest: unknown;
  offered: unknown;
}

const teardownDeadline = "1 second";

const interruptsRun = (key: Key, options: RunOptions): boolean =>
  Key.guards.Eof(key) ||
  (Key.guards.Ctrl(key) && key.letter === "c" && options.handleCtrlC !== true) ||
  (Key.guards.Escape(key) && options.interruptOnEscape === true);

const isKeyed = (command: Command.Command<unknown, unknown, unknown>): boolean =>
  command.key !== undefined || Reflect.has(command, "interruptsKey");

type Runnable<Message, Requirements> = Readonly<{
  name: string;
  args?: Record<string, unknown>;
  effect: Effect.Effect<Message, never, Requirements>;
}>;

/** Foldkit's `Command` type depends on `Message`, so it stays unresolved inside a generic runner. */
const isRunnable = <Message, Requirements>(
  command: Command.Command<Message, never, Requirements>,
): command is Command.Command<Message, never, Requirements> & Runnable<Message, Requirements> =>
  Effect.isEffect(command.effect);

/**
 * Runs a program on the terminal until `result` is `Some`, then returns that value. The terminal is
 * restored on success, failure and interruption; Ctrl+C, EOF and (optionally) Escape interrupt.
 * Only one run owns a terminal's input at a time and a second fails at once with
 * `TerminalError` reason `busy`; while a run is active, other writes to the same TTY corrupt the
 * live region, so log through committed nodes. Keyed and interrupt Commands are not supported yet.
 */
export const run = Effect.fn("Tui.run")(function* <
  Model,
  Message extends { readonly _tag: string },
  A,
  InitRequirements = never,
  UpdateRequirements = never,
  SubscriptionRequirements = never,
>(
  program: Program<
    Model,
    Message,
    A,
    InitRequirements,
    UpdateRequirements,
    SubscriptionRequirements
  >,
  options: RunOptions = {},
) {
  const terminal = yield* Terminal.Service;
  const frameInterval = options.frameInterval ?? "16 millis";
  yield* Effect.annotateCurrentSpan("tui.live", terminal.capabilities.live);

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* terminal.claim;
      const engine = yield* restore(Engine.load);
      const session = yield* terminal.openInput;
      const writer = yield* makeSessionWriter(terminal, engine);
      // Finalizers run in reverse: writes are revoked, then input and the claim are released. A
      // failed run revokes earlier, when its teardown ends, so a slow Command finalizer cannot keep
      // the writer live past the deadline.
      yield* Effect.addFinalizer(() => writer.revoke);
      const children = yield* FiberSet.make<void, never>();
      const queue = yield* Queue.unbounded<Message>();
      const dirty = yield* Queue.sliding<void>(1);
      const outcome = yield* Deferred.make<Finished<Model, A>, Terminal.TerminalError>();

      const settle = (exit: Exit.Exit<Finished<Model, A>, Terminal.TerminalError>) => {
        Deferred.doneUnsafe(outcome, exit);
      };

      yield* session.observe((key) => {
        if (interruptsRun(key, options)) settle(Exit.interrupt());
      });
      const programKeys = Stream.filter(session.keys, (key) => !interruptsRun(key, options));
      const provideKeys = <B, E, Requirements>(effect: Effect.Effect<B, E, Requirements>) =>
        Effect.provideService(effect, Keys, programKeys);

      let latest: { readonly model: Model } | undefined;
      const publishModel = (model: Model) => {
        latest = { model };
        Queue.offerUnsafe(dirty, undefined);
      };

      const sameModel = Schema.toEquivalence(program.Model);

      const renderLoop = Queue.take(dirty).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (latest === undefined) return;
            const { model } = latest;
            writer.publish((viewport) => program.view(model, viewport));
          }),
        ),
        Effect.andThen(Effect.sleep(frameInterval)),
        Effect.forever,
      );
      const renderFiber = yield* FiberSet.run(children, renderLoop);
      yield* FiberSet.run(
        children,
        Stream.runForEach(terminal.resizes, () =>
          Effect.sync(() => {
            Queue.offerUnsafe(dirty, undefined);
          }),
        ),
      );

      const runCommands = Effect.fnUntraced(function* (
        commands: Update.Commands<Message, InitRequirements | UpdateRequirements> | undefined,
      ) {
        const keyed = commands?.find(isKeyed);
        if (keyed !== undefined) {
          return yield* Effect.die(
            new Error(
              `Command ${keyed.name} is keyed; keyed and interrupt Commands are unsupported`,
            ),
          );
        }
        for (const command of commands ?? []) {
          if (!isRunnable(command)) {
            return yield* Effect.die(new Error(`Command ${command.name} has no effect to run`));
          }
          yield* FiberSet.run(
            children,
            command.effect.pipe(
              Effect.flatMap((message) => Queue.offer(queue, message)),
              Effect.withSpan("Tui.command", {
                attributes: { "tui.command.name": command.name, ...command.args },
              }),
              provideKeys,
            ),
          );
        }
      });

      const startSubscriptions = Effect.fnUntraced(function* (model: Model) {
        const followed: Array<FollowedSubscription<Model>> = [];
        for (const entry of Object.values(program.subscriptions ?? {})) {
          const initial: unknown = entry.modelToDependencies(model);
          const subscription: FollowedSubscription<Model> = {
            modelToDependencies: entry.modelToDependencies,
            equivalence:
              entry.keepAliveEquivalence ?? Schema.toEquivalence(entry.dependenciesSchema),
            restarts: yield* Queue.unbounded<unknown>(),
            latest: initial,
            offered: initial,
          };
          followed.push(subscription);
          yield* FiberSet.run(
            children,
            Stream.concat(Stream.make(initial), Stream.fromQueue(subscription.restarts)).pipe(
              Stream.switchMap((dependencies) =>
                entry.dependenciesToStream(dependencies, () => subscription.latest),
              ),
              Stream.runForEach((message) => Queue.offer(queue, message)),
              provideKeys,
            ),
          );
        }
        return followed;
      });

      const follow = (followed: ReadonlyArray<FollowedSubscription<Model>>, model: Model) => {
        for (const subscription of followed) {
          const dependencies = subscription.modelToDependencies(model);
          subscription.latest = dependencies;
          if (!subscription.equivalence(dependencies, subscription.offered)) {
            subscription.offered = dependencies;
            Queue.offerUnsafe(subscription.restarts, dependencies);
          }
        }
      };

      const loop = Effect.gen(function* () {
        const initial = program.init();
        let model = initial.model;
        publishModel(model);
        const booted = program.result(model);
        if (Option.isSome(booted)) return { model, value: booted.value };
        const followed = yield* startSubscriptions(model);
        yield* runCommands(initial.commands);
        while (true) {
          const next = program.update(model, yield* Queue.take(queue));
          const changed = !sameModel(model, next.model);
          model = next.model;
          if (changed) publishModel(model);
          follow(followed, model);
          yield* runCommands(next.commands);
          const done = program.result(model);
          if (Option.isSome(done)) return { model, value: done.value };
        }
      });

      const watch = (effect: Effect.Effect<unknown, Terminal.TerminalError>) =>
        effect.pipe(
          Effect.catchCause((cause) => Effect.sync(() => settle(Exit.failCause(cause)))),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* watch(FiberSet.join(children));
      yield* watch(writer.failure);

      const loopFiber = yield* loop.pipe(
        Effect.onExit((exit) => Effect.sync(() => settle(exit))),
        Effect.forkScoped({ startImmediately: true }),
      );

      const exit = yield* Effect.exit(restore(Deferred.await(outcome)));

      yield* session.close;
      loopFiber.interruptUnsafe();
      renderFiber.interruptUnsafe();
      const cancelling = [...children];
      for (const child of cancelling) child.interruptUnsafe();

      const finalScreen: ScreenFor = (viewport) =>
        latest === undefined ? emptyScreen : program.view(latest.model, viewport);

      const abort = Effect.fn("Tui.run.teardown")(function* (
        cause: Cause.Cause<Terminal.TerminalError>,
      ) {
        const teardown = yield* Effect.forkDetach(writer.teardown(finalScreen), {
          startImmediately: true,
        });
        const deadline = yield* Effect.forkDetach(Effect.sleep(teardownDeadline), {
          startImmediately: true,
        });
        yield* Effect.raceFirst(
          Effect.interruptible(Fiber.await(teardown)),
          Effect.interruptible(Fiber.await(deadline)),
        );
        yield* Fiber.interrupt(deadline);
        yield* writer.revoke;
        return yield* Effect.failCause(cause);
      });

      if (Exit.isFailure(exit)) return yield* abort(exit.cause);
      const { model, value } = exit.value;
      const flushed = yield* Effect.exit(
        restore(writer.finish((viewport) => program.view(model, viewport))),
      );
      if (Exit.isFailure(flushed)) return yield* abort(flushed.cause);
      const defects = (yield* Effect.forEach(cancelling, Fiber.await)).flatMap((cancelled) =>
        Exit.isFailure(cancelled) ? cancelled.cause.reasons.filter(Cause.isDieReason) : [],
      );
      if (defects.length > 0) return yield* Effect.failCause(Cause.fromReasons<never>(defects));
      return value;
    }).pipe(Effect.scoped),
  );
});
