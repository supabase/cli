import * as Engine from "./engine.ts";
import { paintGrid } from "./grid.ts";
import type { Emphasis, Node, Tone } from "./node.ts";
import { repertoireFor } from "./repertoire.ts";
import { makeTextLines, natural } from "./text-lines.ts";
import type { CellLine, TextLines } from "./text-lines.ts";

/** A run of text with one style, at most as wide as its line. */
export interface Segment {
  readonly text: string;
  readonly tone?: Tone;
  readonly emphasis?: Emphasis;
}

/** One terminal row of styled segments. */
export type Line = ReadonlyArray<Segment>;

export interface LayoutOptions {
  /** Cells available per line; lines never exceed it. */
  readonly columns: number;
  /** Draw borders and the ellipsis, and pick glyph alternates, for a terminal that supports unicode. */
  readonly unicode: boolean;
  /** The flexbox engine, loaded once per run. */
  readonly engine: Engine.Engine;
}

/** Floors the offered width, then answers by the engine's width and height modes. */
const measureWith =
  (text: TextLines): Engine.MeasureText =>
  (node, offered, widthMode, limit, heightMode) => {
    const intrinsic = text.natural(node);
    const room = Number.isFinite(offered) ? Math.max(0, Math.floor(offered)) : intrinsic;
    const width =
      widthMode === "undefined"
        ? intrinsic
        : widthMode === "at-most"
          ? Math.min(intrinsic, room)
          : room;
    const count = text.lines(node, width).length;
    const height =
      heightMode === "undefined"
        ? count
        : heightMode === "at-most"
          ? Math.min(count, limit)
          : limit;
    return { width, height };
  };

const toLine = (cells: CellLine): Line => {
  const segments: Array<Segment> = [];
  for (const cell of cells) {
    const last = segments.at(-1);
    if (last !== undefined && last.tone === cell.tone && last.emphasis === cell.emphasis) {
      segments[segments.length - 1] = { ...last, text: last.text + cell.text };
    } else {
      segments.push({
        text: cell.text,
        ...(cell.tone === undefined ? {} : { tone: cell.tone }),
        ...(cell.emphasis === undefined ? {} : { emphasis: cell.emphasis }),
      });
    }
  }
  return segments;
};

/**
 * Lays `node` out into styled lines no wider than `columns` cells. Never throws on content:
 * narrow panes shrink and wrap their text, and what still does not fit is clipped.
 */
export const layout = (node: Node, options: LayoutOptions): ReadonlyArray<Line> => {
  const columns = natural(options.columns);
  if (columns < 1) return [];
  const text = makeTextLines(options.unicode);
  const placed = Engine.compute(options.engine, node, columns, measureWith(text));
  return paintGrid(placed, { columns, repertoire: repertoireFor(options.unicode), text }).map(
    toLine,
  );
};
