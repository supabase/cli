import { Array, Effect, Option, Schema, Stream } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import * as Subscription from "foldkit/subscription";
import type * as Update from "foldkit/update";

import { column, glyph, row, text } from "../view/public.ts";
import type { Glyph, Node, Tone } from "../view/public.ts";
import { glyphs } from "./glyphs.ts";

// MODEL

export const Model = Schema.Struct({ frame: Schema.Finite });
export type Model = typeof Model.Type;

export const init: Model = { frame: 0 };

// MESSAGE

export const Message = defineMessageUnion({ Ticked: {} });
export type Message = typeof Message.Type;

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    Ticked: () => ({ model: modifyFields(model, { frame: (frame) => frame + 1 }) }),
  });

// SUBSCRIPTIONS

const frameInterval = "80 millis";

/** Emits `Ticked` every 80 ms on the Effect Clock; the parent gates it with `Subscription.lift`. */
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  ticked: Subscription.persistentEntry(
    Stream.fromEffectRepeat(Effect.sleep(frameInterval).pipe(Effect.as(Message.Ticked()))),
  ),
}));

// VIEW

export type Status = "running" | "succeeded" | "failed" | "warning";

export interface ViewInputs {
  readonly label: string;
  readonly status?: Status;
  /** Colors the spinner frame while running; stopped statuses use their own tone. */
  readonly tone?: Tone;
}

const stopped: Readonly<
  Record<Exclude<Status, "running">, { readonly glyph: Glyph; readonly tone: Tone }>
> = {
  succeeded: { glyph: glyphs.tick, tone: "success" },
  failed: { glyph: glyphs.cross, tone: "danger" },
  warning: { glyph: glyphs.warning, tone: "warning" },
};

const unicodeFrames: ReadonlyArray<string> = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const asciiFrames: ReadonlyArray<string> = ["-", "\\", "|", "/"];

const frameAt = (frames: ReadonlyArray<string>, index: number): string =>
  Array.get(frames, index % frames.length).pipe(Option.getOrElse(() => frames[0] ?? ""));

/** The glyph for the frame at `index`; each repertoire wraps by its own length. */
const frameGlyph = (index: number): Glyph => {
  const frame = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return { unicode: frameAt(unicodeFrames, frame), ascii: frameAt(asciiFrames, frame) };
};

/** A toned glyph, the current frame while running or the status symbol once stopped, before the label. */
export const view = (
  model: Model,
  { label, status = "running", tone = "accent" }: ViewInputs,
): Node =>
  row(
    [
      column(
        [
          text(
            [
              status === "running"
                ? glyph(frameGlyph(model.frame), { tone })
                : glyph(stopped[status].glyph, { tone: stopped[status].tone }),
            ],
            { wrap: false },
          ),
        ],
        { width: 1, shrink: 0 },
      ),
      column([text(label)], { grow: 1 }),
    ],
    { gap: 1 },
  );
