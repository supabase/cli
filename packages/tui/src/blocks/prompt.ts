import { Array, Effect, Equal, Option, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import * as Subscription from "foldkit/subscription";
import * as Update from "foldkit/update";

import { keyEntry, makeProgram, run } from "../runtime/public.ts";
import type { Keys } from "../runtime/public.ts";
import { Key, Terminal } from "../terminal/public.ts";
import { screen } from "../view/public.ts";
import * as Select from "./select.ts";

/** A prompt needs a TTY on both input and output, and neither is available. */
export class NonInteractive extends Schema.TaggedError<NonInteractive>()("NonInteractive", {}) {
  override get message(): string {
    return "Prompts need an interactive terminal";
  }
}

export interface SelectConfig<A> {
  readonly message: string;
  readonly options: NonEmptyReadonlyArray<{
    readonly value: A;
    readonly label: string;
    readonly hint?: string;
  }>;
  /** The option highlighted first; the first option when omitted or not among the options. */
  readonly initial?: A;
}

const Model = Schema.Struct({
  select: Select.Model,
  maybeSelected: Schema.Option(Schema.String),
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  PressedKey: { key: Key },
  GotSelectMessage: { message: Select.Message },
});
type Message = typeof Message.Type;

const foldSelectOutMessage = (outMessage: Select.OutMessage): Update.Step<Model, Message> =>
  Select.OutMessage.match<Update.Step<Model, Message>>(outMessage, {
    Selected:
      ({ value }) =>
      (model) => ({ model: modifyFields(model, { maybeSelected: () => Option.some(value) }) }),
  });

const selectFold = {
  read: (model: Model) => Option.some(model.select),
  write: (model: Model, select: Select.Model): Model =>
    modifyFields(model, { select: () => select }),
  toParentMessage: (message: Select.Message) => Message.GotSelectMessage({ message }),
  foldOutMessage: foldSelectOutMessage,
};

const foldSelect = Update.foldChild({ ...selectFold, update: Select.update });
const foldSelectKey = Update.foldChild({ ...selectFold, update: Select.informKeyPressed });

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    PressedKey: ({ key }) => foldSelectKey(model, key),
    GotSelectMessage: ({ message }) => foldSelect(model, message),
  });

const subscriptions = Subscription.make<Model, Message, Keys>()(() => ({
  keys: keyEntry((key) => Message.PressedKey({ key })),
}));

/** Select speaks strings, so each option travels as its index and maps back to `A` on the way out. */
const selectProgram = <A>(config: SelectConfig<A>) => {
  const { message, options } = config;
  const selectOptions = options.map(({ label, hint }, index) => ({
    value: String(index),
    label,
    ...(hint === undefined ? {} : { hint }),
  }));
  const initialIndex =
    "initial" in config
      ? Array.findFirstIndex(options, (option) => Equal.equals(option.value, config.initial))
      : Option.none();
  return makeProgram({
    Model,
    init: () => ({
      model: {
        select: Select.init(selectOptions, Option.getOrUndefined(Option.map(initialIndex, String))),
        maybeSelected: Option.none(),
      },
    }),
    update,
    view: (model, { rows }) => screen(Select.view(model.select, { message, rows })),
    subscriptions,
    result: (model) =>
      Option.flatMap(model.maybeSelected, (value) =>
        Option.map(Array.get(options, Number(value)), (option) => option.value),
      ),
  });
};

/**
 * Asks the user to pick one option and returns its value. Escape and Ctrl+C interrupt; a terminal
 * without interactive input or output fails with `NonInteractive` before anything is written.
 */
export const select = Effect.fn("Prompt.select")(function* <A>(config: SelectConfig<A>) {
  const terminal = yield* Terminal.Service;
  if (!terminal.capabilities.interactive) return yield* new NonInteractive();
  return yield* run(selectProgram(config), { interruptOnEscape: true });
});
