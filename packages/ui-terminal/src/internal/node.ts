import { Schema } from "effect";
import { Display, Edge, FlexDirection, Gutter } from "yoga-layout/load";
import type { Node as YogaNode } from "yoga-layout/load";

import { makeTextLines } from "./text-lines.ts";
import type { TextLines } from "./text-lines.ts";
import { isTone } from "../TerminalTheme.ts";
import type { Tone } from "../TerminalTheme.ts";

export const BorderStyle = Schema.Literals(["single", "rounded"]);
export type BorderStyle = typeof BorderStyle.Type;
const isBorderStyle = Schema.is(BorderStyle);

/** A run of text inside a `text` element. */
export class TextNode {
  parent: ElementNode | undefined = undefined;
  text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** A retained element: its props, its children and the Yoga node that lays it out. */
export class ElementNode {
  readonly tag: string;
  readonly yoga: YogaNode;
  readonly children: Array<ElementNode | TextNode> = [];
  readonly props = new Map<string, unknown>();
  parent: ElementNode | undefined = undefined;
  /** For a child of `static`: already written to the scrollback. */
  flushed = false;
  freed = false;
  private cached: TextLines | undefined = undefined;

  constructor(tag: string, yoga: YogaNode) {
    this.tag = tag;
    this.yoga = yoga;
  }

  /** The concatenated text of a `text` element's children. */
  content(): string {
    let text = "";
    for (const child of this.children) if (child instanceof TextNode) text += child.text;
    return text;
  }

  /** The element's text, measured and cached until its content or `truncate` changes. */
  textLines(): TextLines {
    this.cached ??= makeTextLines(this.content(), this.props.get("truncate") === true);
    return this.cached;
  }

  /** Drops the cached text and tells Yoga to measure the `text` leaf again. */
  invalidateText(): void {
    if (this.tag !== "text") return;
    this.cached = undefined;
    this.yoga.markDirty();
  }

  tone(): Tone {
    const tone = this.props.get("tone");
    return isTone(tone) ? tone : "default";
  }

  bold(): boolean {
    return this.props.get("bold") === true;
  }

  dim(): boolean {
    return this.props.get("dim") === true;
  }

  border(): BorderStyle | undefined {
    const border = this.props.get("border");
    return isBorderStyle(border) ? border : undefined;
  }

  borderTone(): Tone {
    const tone = this.props.get("borderTone");
    return isTone(tone) ? tone : "default";
  }

  /** Frees this element's Yoga node and its descendants'. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    for (const child of this.children) if (child instanceof ElementNode) child.markFreed();
    this.yoga.freeRecursive();
  }

  private markFreed(): void {
    this.freed = true;
    for (const child of this.children) if (child instanceof ElementNode) child.markFreed();
  }
}

export type HostNode = ElementNode | TextNode;

const cells = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const size = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? cells(value) : undefined;

/** Stores a prop and applies the ones that shape layout to the element's Yoga node. */
export const applyProp = (element: ElementNode, name: string, value: unknown): void => {
  if (value === undefined) element.props.delete(name);
  else element.props.set(name, value);
  const { yoga } = element;
  switch (name) {
    case "flexDirection":
      yoga.setFlexDirection(value === "row" ? FlexDirection.Row : FlexDirection.Column);
      break;
    case "gap":
      yoga.setGap(Gutter.All, cells(value));
      break;
    case "padding":
      yoga.setPadding(Edge.All, cells(value));
      break;
    case "paddingX":
      yoga.setPadding(Edge.Horizontal, value === undefined ? undefined : cells(value));
      break;
    case "flexGrow":
      yoga.setFlexGrow(cells(value));
      break;
    case "flexShrink":
      yoga.setFlexShrink(cells(value));
      break;
    case "truncate":
      element.invalidateText();
      break;
    case "border":
      yoga.setBorder(Edge.All, isBorderStyle(value) ? 1 : 0);
      break;
    case "width":
      yoga.setWidth(size(value));
      break;
    case "height":
      yoga.setHeight(size(value));
      break;
    default:
      break;
  }
};

/** Hides a node from layout once its content has been written to the scrollback. */
export const hide = (element: ElementNode): void => {
  element.flushed = true;
  element.yoga.setDisplay(Display.None);
};
