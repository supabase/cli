import { Effect, Option, Schema } from "effect";
import * as Command from "foldkit/command";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import * as Subscription from "foldkit/subscription";
import * as Update from "foldkit/update";

import * as Spinner from "../../blocks/spinner.ts";
import { keyEntry, makeProgram } from "../../runtime/public.ts";
import type { Keys } from "../../runtime/public.ts";
import { Key } from "../../terminal/public.ts";
import { column, screen, text } from "../../view/public.ts";

// MODEL

const DatabasePhase = defineTaggedUnion({ Waiting: {}, Succeeded: {} });

const Lifecycle = defineTaggedUnion({ Running: {}, Finished: {} });

const Model = Schema.Struct({
  build: Spinner.Model,
  db: Spinner.Model,
  databasePhase: DatabasePhase,
  lifecycle: Lifecycle,
});
type Model = typeof Model.Type;

// MESSAGE

const Message = defineMessageUnion({
  PressedKey: { key: Key },
  GotBuildSpinnerMessage: { message: Spinner.Message },
  GotDbSpinnerMessage: { message: Spinner.Message },
  CompletedWaitForDatabase: {},
});
type Message = typeof Message.Type;

// COMMAND

const dbDelay = "3200 millis";

const WaitForDatabase = Command.define("WaitForDatabase", {
  messages: [Message.CompletedWaitForDatabase],
  execute: Effect.sleep(dbDelay).pipe(Effect.as(Message.CompletedWaitForDatabase())),
});

// UPDATE

const foldBuild = Update.foldChild({
  update: Spinner.update,
  read: (model: Model) => Option.some(model.build),
  write: (model, build) => modifyFields(model, { build: () => build }),
  toParentMessage: (message: Spinner.Message) => Message.GotBuildSpinnerMessage({ message }),
});

const foldDb = Update.foldChild({
  update: Spinner.update,
  read: (model: Model) => Option.some(model.db),
  write: (model, db) => modifyFields(model, { db: () => db }),
  toParentMessage: (message: Spinner.Message) => Message.GotDbSpinnerMessage({ message }),
});

const finishes = (key: Key): boolean =>
  Key.matchOrElse(key, { Enter: () => true, Char: ({ text }) => text === "q" }, () => false);

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    PressedKey: ({ key }) =>
      finishes(key)
        ? { model: modifyFields(model, { lifecycle: () => Lifecycle.Finished() }) }
        : { model },
    GotBuildSpinnerMessage: ({ message }) => foldBuild(model, message),
    GotDbSpinnerMessage: ({ message }) => foldDb(model, message),
    CompletedWaitForDatabase: () => ({
      model: modifyFields(model, { databasePhase: () => DatabasePhase.Succeeded() }),
    }),
  });

// VIEW

const view = (model: Model) =>
  screen(
    column([
      text("Live", { emphasis: "bold" }),
      Spinner.view(model.build, { label: "Building functions" }),
      Spinner.view(model.db, {
        label: "Applying migrations",
        status: DatabasePhase.match<Spinner.Status>(model.databasePhase, {
          Waiting: () => "running",
          Succeeded: () => "succeeded",
        }),
      }),
      text("enter or q to continue", { tone: "default" }),
    ]),
  );

// SUBSCRIPTIONS

const buildSubscriptions = Subscription.lift(Spinner.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.build),
  toParentMessage: (message) => Message.GotBuildSpinnerMessage({ message }),
});

const dbSubscriptions = Subscription.lift(Spinner.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.db),
  toParentMessage: (message) => Message.GotDbSpinnerMessage({ message }),
  when: (model) =>
    DatabasePhase.match(model.databasePhase, { Waiting: () => true, Succeeded: () => false }),
});

const subscriptions = Subscription.aggregate(
  { buildTicked: buildSubscriptions.ticked },
  { dbTicked: dbSubscriptions.ticked },
  Subscription.make<Model, Message, Keys>()(() => ({
    keys: keyEntry((key) => Message.PressedKey({ key })),
  })),
);

/** Two lifted spinners, one stopped through its `when` gate by a Command; Enter or `q` finishes. */
export const program = makeProgram({
  Model,
  init: () => ({
    model: {
      build: Spinner.init,
      db: Spinner.init,
      databasePhase: DatabasePhase.Waiting(),
      lifecycle: Lifecycle.Running(),
    },
    commands: [WaitForDatabase()],
  }),
  update,
  view,
  subscriptions,
  result: (model) =>
    Lifecycle.match(model.lifecycle, {
      Running: () => Option.none(),
      Finished: () => Option.some(undefined),
    }),
});
