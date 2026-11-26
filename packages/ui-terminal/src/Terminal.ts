import { Component, View } from "@effect/ui";
import { Context } from "effect";

import type { Size } from "./internal/capabilities.ts";
import type { BorderStyle } from "./internal/node.ts";
import type { Tone } from "./TerminalTheme.ts";

/** The vocabulary name a host lists in `elements`. */
export const name = "terminal";

/** Marks that a mount can show this vocabulary, and the session operations Commands use; every mount provides it. */
export class Host extends Context.Service<
  Host,
  {
    /** The terminal's current size. */
    readonly size: () => Size;
    /** Ends the mount: `Mounted.finished` resolves, the final frame stays in the scrollback and `TerminalHost.run` returns. */
    readonly finish: () => void;
  }
>()("@supabase/ui-terminal/Terminal/Host") {}

declare module "@effect/ui/Command" {
  interface FrameworkServices {
    readonly TerminalHost: Host;
  }
}

/** Plain-data payload for key events; the shape `@effect/ui-opentui` gives its key events. */
export interface KeyPayload {
  readonly key: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly repeat: boolean;
  readonly editable: boolean;
}

/** Plain-data payload for terminal resize events, in cells. */
export interface ResizePayload {
  readonly width: number;
  readonly height: number;
}

/** Events an element can emit. Terminal elements emit none: keys, paste and resize arrive through `TerminalSubscription`. */
export interface Events {}

/** Size and flex props of every element: sizes are cells. */
export type LayoutStyle = {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly flexGrow?: number | undefined;
  readonly flexShrink?: number | undefined;
};

/** Props of `box` and `static`. */
export type BoxStyle = LayoutStyle & {
  readonly flexDirection?: "row" | "column" | undefined;
  readonly gap?: number | undefined;
  readonly padding?: number | undefined;
  readonly paddingX?: number | undefined;
  readonly border?: BorderStyle | undefined;
  readonly borderTone?: Tone | undefined;
};

/** Props of `text`; `truncate` keeps each line to one row and ends a cut line with an ellipsis. */
export type TextStyle = LayoutStyle & {
  readonly tone?: Tone | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly truncate?: boolean | undefined;
};

/** Content a container accepts: anything but plain text, which belongs inside `text`. */
export type NoTextInput<Msg, R = never> =
  | View.Element<Msg, R>
  | View.Child<Msg, R>
  | View.Outlet
  | View.ElementBuilder<Msg, R, {}, unknown>
  | false
  | null
  | undefined
  | ReadonlyArray<
      | View.Element<Msg, R>
      | View.Child<Msg, R>
      | View.Outlet
      | View.ElementBuilder<Msg, R, {}, unknown>
      | false
      | null
      | undefined
    >;

class TuiElement<
  out Msg,
  out R,
  out Tag extends string,
  in Style extends Readonly<Record<string, unknown>>,
> extends View.ElementBuilder<Msg, R, {}, unknown, Tag> {
  /** Merges props into the element's host properties; `undefined` removes one. */
  style(options: Style): this {
    let next: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(options)) {
      next ??= { ...this.props };
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next === undefined ? this : View.withFields(this, { props: next });
  }
}

/** A flex container (`box`), or `static`: a column whose children are written to the scrollback once. */
export class BoxElement<out Msg, out R = never, out Tag extends string = string> extends TuiElement<
  Msg,
  R,
  Tag,
  BoxStyle
> {
  /** Adds element children; plain text is rejected, so wrap it in `h.text(...)`. */
  children<const C extends ReadonlyArray<NoTextInput<Msg, unknown>>>(
    ...inputs: C
  ): BoxElement<Msg, R | View.Requirements<C[number]>, Tag> {
    return View.withNoTextContent(this, inputs.flat(), vocabulary);
  }
}

/** A run of wrapping text; children are strings. */
export class TextElement<
  out Msg,
  out R = never,
  out Tag extends string = string,
> extends TuiElement<Msg, R, Tag, TextStyle> {
  children(...inputs: ReadonlyArray<string>): this {
    return View.withContent(this, inputs);
  }
}

/** The element builders this vocabulary adds to `h`. */
export type Tags<Msg> = {
  readonly box: View.Shorthand<BoxElement<Msg, never, "box">>;
  readonly static: View.Shorthand<BoxElement<Msg, never, "static">>;
  readonly text: View.Shorthand<TextElement<Msg, never, "text">>;
};

/** The `h` a view function receives, for blocks written as plain functions of `h`. */
export type H<Msg> = View.WithTags<Msg, unknown, Elements>;

/** The type-level vocabulary. */
export interface Elements extends View.Elements {
  readonly Tags: Tags<this["Msg"]>;
  readonly Host: Host;
}

/** Phantom type carrier so this module's namespace satisfies `View.Vocabulary<Elements>`. */
export const Elements: Elements | undefined = undefined;

/** Root element builders installed on `h`. */
export const tags = {
  box: View.shorthand(new BoxElement("box")),
  static: View.shorthand(new BoxElement("static")),
  text: View.shorthand(new TextElement("text")),
};

/** Standalone vocabulary value for `Component.define({ elements })`. */
export const vocabulary: View.Vocabulary<Elements> = { name, tags, textParents: ["text"] };

/** Defines a component with this vocabulary already supplied. */
export const component: Component.Define<Elements> = (options) =>
  // -- `Define`'s generic signature cannot be satisfied without a cast, as in `@effect/ui-opentui`;
  // an upstream gap that a typed `withElements` on `Component` would close.
  Component.define({ ...options, elements: vocabulary }) as never;
