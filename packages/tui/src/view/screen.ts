import type { Size } from "../capabilities.ts";
import { Node } from "./node.ts";

/**
 * The size a view may draw into, sampled together with the layout it is drawn at. `rows` is the
 * budget of the live region; the final frame can exceed it and scroll.
 */
export type Viewport = Size;

/**
 * What a view returns: `committed` nodes are appended to scrollback once and never redrawn,
 * `live` is the region redrawn in place.
 */
export interface Screen {
  /** Cumulative and append-only: every view returns all nodes committed so far, never fewer. */
  readonly committed: ReadonlyArray<Node>;
  readonly live: Node;
}

/** Builds a screen from its live region and the nodes to append to scrollback first. */
export const screen = (live: Node, committed: ReadonlyArray<Node> = []): Screen => ({
  committed,
  live,
});

/** A screen that draws and commits nothing. */
export const emptyScreen: Screen = screen(Node.Empty());
