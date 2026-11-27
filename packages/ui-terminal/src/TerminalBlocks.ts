import { Subscription, UiSchema } from "@effect/ui";
import { Schema, Stream } from "effect";

import { glyphs, pick, spinnerFrames } from "./internal/glyphs.ts";
import type { Glyph } from "./internal/glyphs.ts";
import * as Terminal from "./Terminal.ts";
import * as TerminalSubscription from "./TerminalSubscription.ts";
import * as TerminalTheme from "./TerminalTheme.ts";

/** The states of a `Spinner`. */
export const Status = Schema.Literals(["running", "succeeded", "failed", "warning"]);
export type Status = typeof Status.Type;

/** Props of `Spinner`; `unicode` picks glyphs or their ASCII stand-ins. */
export const SpinnerProps = Schema.Struct({
  label: Schema.String,
  status: Schema.optionalKey(Status),
  tone: Schema.optionalKey(TerminalTheme.Tone),
  unicode: Schema.Boolean,
});

const SpinnerMessage = UiSchema.TaggedEnum({ Ticked: {} });

const stopped: Record<Exclude<Status, "running">, { glyph: Glyph; tone: TerminalTheme.Tone }> = {
  succeeded: { glyph: glyphs.tick, tone: "success" },
  failed: { glyph: glyphs.cross, tone: "danger" },
  warning: { glyph: glyphs.warning, tone: "warning" },
};

/** A status line: an animated glyph while running, a toned one once it has stopped. */
export const Spinner = Terminal.component({
  name: "Spinner",
  props: SpinnerProps,
  model: Schema.Struct({ frame: Schema.Finite }),
  message: SpinnerMessage,
}).make({
  init: () => ({ frame: 0 }),
  update: { Ticked: ($) => $.evolve({ frame: (frame) => frame + 1 }) },
  subscriptions: ({ props }) => [
    (props.status ?? "running") === "running" &&
      Subscription.make(
        "frames",
        Stream.tick("80 millis").pipe(
          Stream.drop(1),
          Stream.map(() => SpinnerMessage.Ticked()),
        ),
      ),
  ],
  view: (h, model) => {
    const status = h.props.status ?? "running";
    const frame = spinnerFrames[model.frame % spinnerFrames.length] ?? glyphs.bullet;
    const shown =
      status === "running" ? { glyph: frame, tone: h.props.tone ?? "accent" } : stopped[status];
    return h.box
      .style({ flexDirection: "row", gap: 1 })
      .children(
        h.text.style({ tone: shown.tone }).children(pick(shown.glyph, h.props.unicode)),
        h.text.style({ flexShrink: 1 }).children(h.props.label),
      );
  },
});

const SelectOption = Schema.Struct({
  label: Schema.String,
  hint: Schema.optionalKey(Schema.String),
});

/** Props of `Select`; `initial` is the index highlighted first. */
export const SelectProps = Schema.Struct({
  message: Schema.String,
  options: Schema.Array(SelectOption),
  initial: Schema.optionalKey(Schema.Finite),
  unicode: Schema.Boolean,
});

const SelectModel = Schema.Struct({
  highlighted: Schema.Finite,
  submitted: Schema.Boolean,
});

const SelectMessage = UiSchema.TaggedEnum({
  PressedUp: {},
  PressedDown: {},
  PressedHome: {},
  PressedEnd: {},
  PressedEnter: {},
});

/** Events of `Select`: `Submitted` carries the chosen option's index. */
export const SelectEvents = UiSchema.TaggedEnum({ Submitted: { index: Schema.Finite } });

const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ");

/**
 * A step glyph and message, then a radio list, or the chosen label once submitted. Long labels
 * are cut with an ellipsis, so the list keeps one row per option.
 */
export const Select = Terminal.component({
  name: "Select",
  props: SelectProps,
  model: SelectModel,
  message: SelectMessage,
  events: SelectEvents,
}).make({
  init: ($) => ({ highlighted: $.props.initial ?? 0, submitted: false }),
  update: {
    PressedUp: ($) =>
      $.model.submitted
        ? $.model
        : $.evolve({
            highlighted: (n) => (n + $.props.options.length - 1) % $.props.options.length,
          }),
    PressedDown: ($) =>
      $.model.submitted
        ? $.model
        : $.evolve({ highlighted: (n) => (n + 1) % $.props.options.length }),
    PressedHome: ($) => ($.model.submitted ? $.model : $.evolve({ highlighted: 0 })),
    PressedEnd: ($) =>
      $.model.submitted ? $.model : $.evolve({ highlighted: $.props.options.length - 1 }),
    PressedEnter: ($) =>
      $.model.submitted
        ? $.model
        : $.evolve({ submitted: true }).emit(
            SelectEvents.Submitted({ index: $.model.highlighted }),
          ),
  },
  subscriptions: ({ model }) => [
    !model.submitted &&
      TerminalSubscription.shortcuts([
        { key: "up", message: SelectMessage.PressedUp() },
        { key: "down", message: SelectMessage.PressedDown() },
        { key: "home", message: SelectMessage.PressedHome() },
        { key: "end", message: SelectMessage.PressedEnd() },
        { key: "return", message: SelectMessage.PressedEnter() },
      ]),
  ],
  view: (h, model) => {
    const { message, options, unicode } = h.props;
    const g = (glyph: Glyph) => pick(glyph, unicode);
    const header = (glyph: string, tone: "accent" | "success") =>
      h.box
        .style({ flexDirection: "row", gap: 1 })
        .children(
          h.text.style({ tone }).children(glyph),
          h.text.style({ bold: true, flexShrink: 1, truncate: true }).children(oneLine(message)),
        );
    if (model.submitted) {
      const chosen = options[model.highlighted];
      return h.box
        .style({ flexDirection: "column" })
        .children(
          header(g(glyphs.stepSubmitted), "success"),
          h.box
            .style({ flexDirection: "row", gap: 1 })
            .children(
              h.text.style({ tone: "muted" }).children(g(glyphs.bar)),
              h.text
                .style({ flexShrink: 1, truncate: true })
                .children(oneLine(chosen?.label ?? "")),
            ),
        );
    }
    return h.box.style({ flexDirection: "column" }).children(
      header(g(glyphs.stepActive), "accent"),
      options.map((option, index) => {
        const active = index === model.highlighted;
        return h.box
          .style({ flexDirection: "row", gap: 1 })
          .children(
            h.text.style({ tone: "muted" }).children(g(glyphs.bar)),
            h.text
              .style({ tone: active ? "accent" : "muted" })
              .children(g(active ? glyphs.radioOn : glyphs.radioOff)),
            h.text
              .style({ bold: active, flexShrink: 1, truncate: true })
              .children(oneLine(option.label)),
            option.hint === undefined
              ? null
              : h.text.style({ tone: "muted" }).children(`(${oneLine(option.hint)})`),
          );
      }),
      h.text.style({ tone: "muted" }).children(g(glyphs.barEnd)),
    );
  },
});

/** Input of `KeyValue`. */
export interface KeyValueConfig {
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly tone?: TerminalTheme.Tone;
  readonly unicode: boolean;
}

const maxKeyWidth = 24;

/** Aligned bold keys beside their values, with an optional toned gutter glyph. */
export const KeyValue = <Msg>(h: Terminal.H<Msg>, { entries, tone, unicode }: KeyValueConfig) => {
  const keyWidth = Math.min(Math.max(0, ...entries.map((entry) => entry.key.length)), maxKeyWidth);
  return h.box
    .style({ flexDirection: "column" })
    .children(
      entries.map(({ key, value }) =>
        h.box
          .style({ flexDirection: "row", gap: 1 })
          .children(
            tone === undefined
              ? null
              : h.text.style({ tone }).children(pick(glyphs.bullet, unicode)),
            h.text.style({ bold: true, width: keyWidth, truncate: true }).children(key),
            h.text.style({ flexGrow: 1, flexShrink: 1 }).children(value),
          ),
      ),
    );
};
