import { Function, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";

import { glyphs } from "../../blocks/glyphs.ts";
import { isModified, Key } from "../../terminal/public.ts";
import { column, glyph, row, text } from "../../view/public.ts";
import type { Node } from "../../view/public.ts";

// MODEL

export const Model = Schema.Struct({ count: Schema.Finite });
export type Model = typeof Model.Type;

export const init: Model = { count: 0 };

// MESSAGE

export const Message = defineMessageUnion({
  Decremented: {},
  Incremented: {},
});
export type Message = typeof Message.Type;

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    Decremented: () => ({ model: modifyFields(model, { count: (count) => count - 1 }) }),
    Incremented: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),
  });

/** Lets a parent hand the focused counter a key: left/`-` decrement, right/`+` increment. */
export const informKeyPressed: {
  (key: Key): (model: Model) => Update.Return<Model, Message>;
  (model: Model, key: Key): Update.Return<Model, Message>;
} = Function.dual(2, (model: Model, key: Key): Update.Return<Model, Message> =>
  isModified(key)
    ? { model }
    : Key.matchOrElse(
        key,
        {
          Left: () => update(model, Message.Decremented()),
          Right: () => update(model, Message.Incremented()),
          Char: ({ text }) => {
            if (text === "-") return update(model, Message.Decremented());
            if (text === "+") return update(model, Message.Incremented());
            return { model };
          },
        },
        () => ({ model }),
      ),
);

// VIEW

export interface ViewInputs {
  readonly focused: boolean;
}

export const view = (model: Model, { focused }: ViewInputs): Node =>
  row(
    [
      column([text(focused ? [glyph(glyphs.pointer, { tone: "accent" })] : " ", { wrap: false })], {
        width: 1,
        shrink: 0,
      }),
      text(`count ${model.count}`, focused ? { emphasis: "bold" } : {}),
    ],
    { gap: 1 },
  );
