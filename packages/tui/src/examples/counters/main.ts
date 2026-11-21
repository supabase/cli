import { Array, Match, Option, Schema, pipe } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import * as Subscription from "foldkit/subscription";
import * as Update from "foldkit/update";

import { keyEntry, makeProgram } from "../../runtime/public.ts";
import type { Keys } from "../../runtime/public.ts";
import { isModified, Key } from "../../terminal/public.ts";
import { column, screen, text, widestLine } from "../../view/public.ts";
import type { Node } from "../../view/public.ts";
import * as Counter from "./counter.ts";

// MODEL

const Row = Schema.Struct({
  id: Schema.String,
  counter: Counter.Model,
});
type Row = typeof Row.Type;

export const Lifecycle = defineTaggedUnion({ Counting: {}, Finished: {} });
export type Lifecycle = typeof Lifecycle.Type;

export const Model = Schema.Struct({
  rows: Schema.Array(Row),
  nextRowId: Schema.Finite,
  focus: Schema.Finite,
  lifecycle: Lifecycle,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  PressedKey: { key: Key },
  GotCounterMessage: {
    id: Schema.String,
    message: Counter.Message,
  },
});
export type Message = typeof Message.Type;

// UPDATE

const readCounter = (model: Model, id: string) =>
  pipe(
    Array.findFirst(model.rows, (row) => row.id === id),
    Option.map((row) => row.counter),
  );

const writeCounter = (model: Model, id: string, nextCounter: Counter.Model): Model =>
  modifyFields(model, {
    rows: Array.map((row) =>
      row.id === id ? modifyFields(row, { counter: () => nextCounter }) : row,
    ),
  });

const toGotCounterMessage = (id: string, message: Counter.Message) =>
  Message.GotCounterMessage({ id, message });

const foldCounter = Update.foldChildAt({
  update: Counter.update,
  readAt: readCounter,
  writeAt: writeCounter,
  toParentMessage: toGotCounterMessage,
});

const foldCounterKey = Update.foldChildAt({
  update: Counter.informKeyPressed,
  readAt: readCounter,
  writeAt: writeCounter,
  toParentMessage: toGotCounterMessage,
});

const clampFocus = (focus: number, rowCount: number) => Math.max(0, Math.min(focus, rowCount - 1));

const moveFocus = (model: Model, step: number) =>
  modifyFields(model, { focus: (focus) => clampFocus(focus + step, model.rows.length) });

const addRow = (model: Model) =>
  modifyFields(model, {
    rows: Array.append({ id: `counter-${model.nextRowId}`, counter: Counter.init }),
    nextRowId: (nextRowId) => nextRowId + 1,
    focus: () => model.rows.length,
  });

const removeFocusedRow = (model: Model) => {
  const rows = Array.remove(model.rows, model.focus);
  return modifyFields(model, {
    rows: () => rows,
    focus: (focus) => clampFocus(focus, rows.length),
  });
};

const informFocusedCounter = (model: Model, key: Key): Update.Return<Model, Message> =>
  pipe(
    Array.get(model.rows, model.focus),
    Option.match({
      onNone: () => ({ model }),
      onSome: (row) => foldCounterKey(model, row.id, key),
    }),
  );

const pressKey = (model: Model, key: Key): Update.Return<Model, Message> => {
  if (isModified(key)) return { model };
  return Key.matchOrElse(
    key,
    {
      Up: () => ({ model: moveFocus(model, -1) }),
      Down: () => ({ model: moveFocus(model, 1) }),
      Backspace: () => ({ model: removeFocusedRow(model) }),
      Delete: () => ({ model: removeFocusedRow(model) }),
      Char: ({ text }) =>
        Match.value(text).pipe(
          Match.when("a", () => ({ model: addRow(model) })),
          Match.when("x", () => ({ model: removeFocusedRow(model) })),
          Match.when("q", () => ({
            model: modifyFields(model, { lifecycle: () => Lifecycle.Finished() }),
          })),
          Match.orElse(() => informFocusedCounter(model, key)),
        ),
    },
    () => informFocusedCounter(model, key),
  );
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PressedKey: ({ key }) => pressKey(model, key),
    GotCounterMessage: ({ id, message }) => foldCounter(model, id, message),
  });

// INIT

const init = () => ({
  model: {
    rows: [
      { id: "counter-0", counter: Counter.init },
      { id: "counter-1", counter: Counter.init },
      { id: "counter-2", counter: Counter.init },
    ],
    nextRowId: 3,
    focus: 0,
    lifecycle: Lifecycle.Counting(),
  },
});

// VIEW

const rowView = (row: Row, focused: boolean): Node => Counter.view(row.counter, { focused });

const chromeRows = 2;

const fullHelp = "up/down focus  left/right or -/+ change  a add  x remove  q quit";
const compactHelp = "^v<> a add x del q quit";

const view = (
  model: Model,
  { rows, columns }: { readonly rows: number; readonly columns: number },
) => {
  const size = Math.max(1, rows - chromeRows);
  const start = Math.max(0, Math.min(model.focus - Math.floor(size / 2), model.rows.length - size));
  return screen(
    column([
      text(`Counters (${model.rows.length})`, { emphasis: "bold", wrap: false }),
      ...(model.rows.length === 0
        ? [text("no counters; press a to add one", { tone: "muted", wrap: false })]
        : model.rows
            .slice(start, start + size)
            .map((row, offset) => rowView(row, start + offset === model.focus))),
      text(widestLine(fullHelp) < columns ? fullHelp : compactHelp, {
        tone: "default",
        wrap: false,
      }),
    ]),
  );
};

// SUBSCRIPTIONS

const subscriptions = Subscription.make<Model, Message, Keys>()(() => ({
  keys: keyEntry((key) => Message.PressedKey({ key })),
}));

/** The keyed counters as a runnable program; `q` finishes it with every row's final count. */
export const program = makeProgram({
  Model,
  init,
  update,
  view,
  subscriptions,
  result: (model) =>
    Lifecycle.match(model.lifecycle, {
      Counting: () => Option.none(),
      Finished: () => Option.some(model.rows.map((row) => row.counter.count)),
    }),
});
