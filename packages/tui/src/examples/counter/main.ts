import { Match, Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import * as Subscription from "foldkit/subscription";
import type * as Update from "foldkit/update";

import { keyEntry, makeProgram } from "../../runtime/public.ts";
import type { Keys } from "../../runtime/public.ts";
import { isModified, Key } from "../../terminal/public.ts";
import { column, screen, text } from "../../view/public.ts";

// MODEL

export const Lifecycle = defineTaggedUnion({ Counting: {}, Finished: {} });
export type Lifecycle = typeof Lifecycle.Type;

export const Model = Schema.Struct({ count: Schema.Finite, lifecycle: Lifecycle });
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  PressedKey: { key: Key },
});
export type Message = typeof Message.Type;

// UPDATE

const applyKey = (model: Model, key: Key): Model => {
  if (isModified(key)) return model;
  const add = (step: number) => modifyFields(model, { count: (count) => count + step });
  return Key.matchOrElse(
    key,
    {
      Up: () => add(1),
      Down: () => add(-1),
      Char: ({ text }) =>
        Match.value(text).pipe(
          Match.when("+", () => add(1)),
          Match.when("-", () => add(-1)),
          Match.when("r", () => modifyFields(model, { count: () => 0 })),
          Match.when("q", () => modifyFields(model, { lifecycle: () => Lifecycle.Finished() })),
          Match.orElse(() => model),
        ),
    },
    () => model,
  );
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PressedKey: ({ key }) => ({ model: applyKey(model, key) }),
  });

// INIT

const init = () => ({ model: { count: 0, lifecycle: Lifecycle.Counting() } });

// VIEW

const view = (model: Model) =>
  screen(
    column([
      text("Counter", { emphasis: "bold" }),
      text(String(model.count)),
      text("up/+ increment  down/- decrement  r reset  q quit", { tone: "default" }),
    ]),
  );

// SUBSCRIPTIONS

const subscriptions = Subscription.make<Model, Message, Keys>()(() => ({
  keys: keyEntry((key) => Message.PressedKey({ key })),
}));

/** The counter as a runnable program; `q` finishes it with the final count. */
export const program = makeProgram({
  Model,
  init,
  update,
  view,
  subscriptions,
  result: (model) =>
    Lifecycle.match(model.lifecycle, {
      Counting: () => Option.none(),
      Finished: () => Option.some(model.count),
    }),
});
