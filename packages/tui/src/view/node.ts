import { Data } from "effect";

/** Semantic color role; the theme owns the actual color. */
export type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger" | "info";

/** A text attribute applied on top of the tone. */
export type Emphasis = "bold" | "dim" | "italic" | "underline" | "inverse";

/**
 * A character with an ASCII alternate. Layout picks the one the terminal supports, so programs
 * never read capabilities.
 */
export type Glyph = Readonly<{ unicode: string; ascii: string }>;

export type BorderStyle = "single" | "rounded";

/**
 * A run of text with one style. `text` is untrusted and normalized by layout; a `glyph` renders
 * the alternate the terminal supports before `text`, in the same style.
 */
export interface Span {
  readonly text: string;
  readonly tone?: Tone;
  readonly emphasis?: Emphasis;
  readonly glyph?: Glyph;
}

interface Border {
  readonly style: BorderStyle;
  readonly tone: Tone;
}

/** Cells, or a percentage of the parent's content width. */
export type Length = number | `${number}%`;

/** Main-axis distribution of a box's children. */
export type Justify =
  | "start"
  | "center"
  | "end"
  | "space-between"
  | "space-around"
  | "space-evenly";

/** Cross-axis placement of a box's children. */
export type Align = "start" | "center" | "end" | "stretch";

/** One child's override of its parent's `align`. */
export type AlignSelf = Align | "auto";

/**
 * The view tree: plain data a pure `view` returns and `layout` measures. A `Box` maps one-to-one
 * onto flexbox: sizes are cells (`width` also takes a percentage) and negative or non-finite
 * numbers count as 0.
 */
export type Node = Data.TaggedEnum<{
  Text: {
    readonly spans: ReadonlyArray<Span>;
    /** Wrap at word boundaries; otherwise truncate each hard line with an ellipsis. */
    readonly wrap: boolean;
  };
  Box: {
    readonly direction: "row" | "column";
    /** Cells between children, on both axes. */
    readonly gap: number;
    readonly padding: {
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      readonly left: number;
    };
    readonly border?: Border;
    readonly width?: Length;
    readonly minWidth?: number;
    readonly maxWidth?: number;
    readonly height?: number;
    readonly minHeight?: number;
    readonly maxHeight?: number;
    readonly basis?: number;
    readonly grow: number;
    readonly shrink: number;
    readonly justify?: Justify;
    readonly align?: Align;
    readonly alignSelf?: AlignSelf;
    /** Wrap children onto new lines instead of shrinking them. */
    readonly wrap: boolean;
    readonly children: ReadonlyArray<Node>;
  };
  Empty: {};
}>;

export const Node = Data.taggedEnum<Node>();

export type TextNode = Data.TaggedEnum.Value<Node, "Text">;
export type BoxNode = Data.TaggedEnum.Value<Node, "Box">;
