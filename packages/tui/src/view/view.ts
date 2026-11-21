import type {
  Align,
  AlignSelf,
  BorderStyle,
  Emphasis,
  Glyph,
  Justify,
  Length,
  Span,
  Tone,
} from "./node.ts";
import { Node } from "./node.ts";

/** The tone and emphasis of a run of text. */
export interface Style {
  readonly tone?: Tone;
  readonly emphasis?: Emphasis;
}

/** A text node's style and whether its lines wrap or truncate. */
export interface TextOptions extends Style {
  /** Wrap long lines at word boundaries (default); `false` truncates with an ellipsis. */
  readonly wrap?: boolean;
}

/** Padding per side; a side wins over its axis, and unset sides are 0. */
export interface Padding {
  readonly x?: number;
  readonly y?: number;
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

/** Flexbox sizing, spacing, border and alignment of a `row` or `column`. */
export interface BoxOptions {
  /** Cells between children on both axes. */
  readonly gap?: number;
  readonly padding?: number | Padding;
  readonly border?: BorderStyle | { readonly style?: BorderStyle; readonly tone?: Tone };
  /** Cells, or a percentage of the parent's content width (the parent needs a definite width). */
  readonly width?: Length;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  /** Starting main-axis size before grow and shrink. */
  readonly basis?: number;
  /** Share of the leftover main-axis space (default 0). */
  readonly grow?: number;
  /** Share of the overflow to give back (default 1); 0 keeps the size. */
  readonly shrink?: number;
  readonly justify?: Justify;
  readonly align?: Align;
  readonly alignSelf?: AlignSelf;
  /** Wrap children onto new lines. */
  readonly wrap?: boolean;
}

/** A run of text with one style, for mixing styles inside a `text` node. */
export const span = (text: string, style: Style = {}): Span => ({ text, ...style });

/** A glyph as its own span; layout writes its unicode or ASCII form. */
export const glyph = (value: Glyph, style: Style = {}): Span => ({
  text: "",
  glyph: value,
  ...style,
});

/** Bare strings in `content` take `options`' style; `Span` items keep their own. */
export const text = (
  content: string | ReadonlyArray<Span | string>,
  options: TextOptions = {},
): Node => {
  const { wrap = true, ...style } = options;
  const items = typeof content === "string" ? [content] : content;
  return Node.Text({
    spans: items.map((item) => (typeof item === "string" ? span(item, style) : item)),
    wrap,
  });
};

/** A node that draws nothing and takes no space. */
export const empty: Node = Node.Empty();

const resolvePadding = (padding: number | Padding) =>
  typeof padding === "number"
    ? { top: padding, right: padding, bottom: padding, left: padding }
    : {
        top: padding.top ?? padding.y ?? 0,
        right: padding.right ?? padding.x ?? 0,
        bottom: padding.bottom ?? padding.y ?? 0,
        left: padding.left ?? padding.x ?? 0,
      };

const resolveBorder = (
  border: NonNullable<BoxOptions["border"]>,
): { readonly style: BorderStyle; readonly tone: Tone } => {
  if (typeof border === "string") return { style: border, tone: "default" };
  return { style: border.style ?? "single", tone: border.tone ?? "default" };
};

const box = (
  direction: "row" | "column",
  children: ReadonlyArray<Node>,
  options: BoxOptions,
): Node => {
  const {
    gap = 0,
    padding = 0,
    border,
    grow = 0,
    shrink = 1,
    wrap = false,
    width,
    minWidth,
    maxWidth,
    height,
    minHeight,
    maxHeight,
    basis,
    justify,
    align,
    alignSelf,
  } = options;
  return Node.Box({
    direction,
    gap,
    padding: resolvePadding(padding),
    grow,
    shrink,
    wrap,
    ...(border === undefined ? {} : { border: resolveBorder(border) }),
    ...(width === undefined ? {} : { width }),
    ...(minWidth === undefined ? {} : { minWidth }),
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(height === undefined ? {} : { height }),
    ...(minHeight === undefined ? {} : { minHeight }),
    ...(maxHeight === undefined ? {} : { maxHeight }),
    ...(basis === undefined ? {} : { basis }),
    ...(justify === undefined ? {} : { justify }),
    ...(align === undefined ? {} : { align }),
    ...(alignSelf === undefined ? {} : { alignSelf }),
    children,
  });
};

/** Lays `children` out left to right. */
export const row = (children: ReadonlyArray<Node>, options: BoxOptions = {}): Node =>
  box("row", children, options);

/** Lays `children` out top to bottom. */
export const column = (children: ReadonlyArray<Node>, options: BoxOptions = {}): Node =>
  box("column", children, options);

/** Takes the leftover main-axis space of its parent; pushes siblings after it to the end. */
export const spacer = (): Node => column([], { grow: 1 });
