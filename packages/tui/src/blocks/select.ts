import { Array, Function, Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";

import { isModified, Key } from "../terminal/public.ts";
import { column, glyph, row, span, text } from "../view/public.ts";
import type { Node, Span } from "../view/public.ts";
import { glyphs } from "./glyphs.ts";

// MODEL

const SelectOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  hint: Schema.optionalKey(Schema.String),
});
export type SelectOption = typeof SelectOption.Type;

/** Whether the select is still being navigated or has locked in an option. */
export const Phase = defineTaggedUnion({
  Choosing: { highlighted: Schema.Finite },
  Submitted: { option: SelectOption },
});
export type Phase = typeof Phase.Type;

export const Model = Schema.Struct({
  options: Schema.Array(SelectOption),
  phase: Phase,
});
export type Model = typeof Model.Type;

/** Highlights the option whose value is `initial`, or the first one. */
export const init = (options: ReadonlyArray<SelectOption>, initial?: string): Model => ({
  options,
  phase: Phase.Choosing({
    highlighted: Option.getOrElse(
      Array.findFirstIndex(options, (option) => option.value === initial),
      () => 0,
    ),
  }),
});

// MESSAGE

export const Message = defineMessageUnion({
  MovedUp: {},
  MovedDown: {},
  MovedToFirst: {},
  MovedToLast: {},
  Confirmed: {},
});
export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({ Selected: { value: Schema.String } });
export type OutMessage = typeof OutMessage.Type;

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

const highlight = (model: Model, highlighted: number): UpdateReturn => ({
  model: modifyFields(model, { phase: () => Phase.Choosing({ highlighted }) }),
});

export const update = (model: Model, message: Message): UpdateReturn => {
  const count = model.options.length;
  if (count === 0) return { model };
  return Phase.match<UpdateReturn>(model.phase, {
    Submitted: () => ({ model }),
    Choosing: ({ highlighted }) =>
      Message.match<UpdateReturn>(message, {
        MovedUp: () => highlight(model, (highlighted + count - 1) % count),
        MovedDown: () => highlight(model, (highlighted + 1) % count),
        MovedToFirst: () => highlight(model, 0),
        MovedToLast: () => highlight(model, count - 1),
        Confirmed: () =>
          Option.match(Array.get(model.options, highlighted), {
            onNone: () => ({ model }),
            onSome: (option) => ({
              model: modifyFields(model, { phase: () => Phase.Submitted({ option }) }),
              outMessage: OutMessage.Selected({ value: option.value }),
            }),
          }),
      }),
  });
};

/** Lets a parent hand the select a key: up/down wrap, home/end jump, enter submits. */
export const informKeyPressed: {
  (key: Key): (model: Model) => UpdateReturn;
  (model: Model, key: Key): UpdateReturn;
} = Function.dual(2, (model: Model, key: Key): UpdateReturn =>
  isModified(key)
    ? { model }
    : Key.matchOrElse(
        key,
        {
          Up: () => update(model, Message.MovedUp()),
          Down: () => update(model, Message.MovedDown()),
          Home: () => update(model, Message.MovedToFirst()),
          End: () => update(model, Message.MovedToLast()),
          Enter: () => update(model, Message.Confirmed()),
        },
        () => ({ model }),
      ),
);

/** Replaces the options silently: the highlighted value stays highlighted if it survives, else the index is clamped. */
export const reflectOptions: {
  (options: ReadonlyArray<SelectOption>): (model: Model) => Model;
  (model: Model, options: ReadonlyArray<SelectOption>): Model;
} = Function.dual(2, (model: Model, options: ReadonlyArray<SelectOption>): Model =>
  Phase.match<Model>(model.phase, {
    Submitted: () => modifyFields(model, { options: () => options }),
    Choosing: ({ highlighted }) => {
      const surviving = Option.flatMap(Array.get(model.options, highlighted), (current) =>
        Array.findFirstIndex(options, (option) => option.value === current.value),
      );
      return modifyFields(model, {
        options: () => options,
        phase: () =>
          Phase.Choosing({
            highlighted: Option.getOrElse(surviving, () =>
              Math.max(0, Math.min(highlighted, options.length - 1)),
            ),
          }),
      });
    },
  }),
);

// VIEW

export interface ViewInputs {
  readonly message: string;
  /** Lines the block may occupy: the header and footer count against it. */
  readonly rows: number;
}

/** First visible option index, centering the highlight and keeping the window inside the list. */
const windowStart = (highlighted: number, optionCount: number, size: number) =>
  Math.max(0, Math.min(highlighted - Math.floor(size / 2), optionCount - size));

const glyphCell = (glyph: Span): Node =>
  column([text([glyph], { wrap: false })], { width: 1, shrink: 0 });

const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ");

const headerRow = (glyph: Span, message: Node): Node =>
  row([glyphCell(glyph), column([message], { grow: 1 })], { gap: 1 });

const optionRow = (option: SelectOption, active: boolean): Node =>
  row(
    [
      glyphCell(glyph(glyphs.bar, { tone: "muted" })),
      glyphCell(
        glyph(active ? glyphs.radioOn : glyphs.radioOff, { tone: active ? "accent" : "muted" }),
      ),
      column(
        [
          text(
            [
              span(oneLine(option.label), active ? { emphasis: "bold" } : {}),
              ...(option.hint === undefined
                ? []
                : [span(` (${oneLine(option.hint)})`, { tone: "muted" })]),
            ],
            { wrap: false },
          ),
        ],
        { grow: 1 },
      ),
    ],
    { gap: 1 },
  );

/**
 * A clack-style prompt: step glyph and message, then a scrolling radio list, or the chosen label
 * once submitted. Below three rows the footer and then the header give way to the highlighted option.
 */
export const view = (model: Model, { message, rows }: ViewInputs): Node =>
  Phase.match<Node>(model.phase, {
    Choosing: ({ highlighted }) => {
      const decorated = rows >= 3;
      const size = Math.max(1, Math.min(model.options.length, decorated ? rows - 2 : 1));
      const start = windowStart(highlighted, model.options.length, size);
      return column([
        ...(rows >= 2
          ? [
              headerRow(
                glyph(glyphs.stepActive, { tone: "accent" }),
                text(oneLine(message), { emphasis: "bold", wrap: false }),
              ),
            ]
          : []),
        ...model.options
          .slice(start, start + size)
          .map((option, offset) => optionRow(option, start + offset === highlighted)),
        ...(decorated ? [text([glyph(glyphs.barEnd, { tone: "muted" })], { wrap: false })] : []),
      ]);
    },
    Submitted: ({ option }) =>
      column([
        headerRow(
          glyph(glyphs.stepSubmitted, { tone: "success" }),
          text(message, { emphasis: "bold" }),
        ),
        row(
          [
            glyphCell(glyph(glyphs.bar, { tone: "muted" })),
            column([text(option.label)], { grow: 1 }),
          ],
          { gap: 1 },
        ),
      ]),
  });
