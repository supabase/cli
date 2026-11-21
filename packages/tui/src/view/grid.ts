import type { Placed } from "./engine.ts";
import type { BoxNode } from "./node.ts";
import type { Repertoire } from "./repertoire.ts";
import { cellsOfPieces, styleOf } from "./text-lines.ts";
import type { Cell, CellLine, TextLines } from "./text-lines.ts";
import { width } from "./width.ts";

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The cells a wide glyph covers after its first one. */
const COVERED: Cell = { text: "", width: 0 };
const SPACE: Cell = { text: " ", width: 1 };

type Slot = Cell | undefined;

/** Absolute edges snap to 1/1024 of a cell first, so float32 noise never splits a shared edge. */
const snap = (edge: number): number => Math.round(Math.round(edge * 1024) / 1024);

const intersect = (a: Rect, b: Rect): Rect => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});

/** Writes `cell` at (x, y) inside `clip`; a glyph cut by the clip leaves styled spaces instead. */
const put = (grid: Array<Array<Slot>>, clip: Rect, x: number, y: number, cell: Cell): void => {
  const row = grid[y];
  if (row === undefined || y < clip.y0 || y >= clip.y1 || cell.width < 1) return;
  if (x >= clip.x0 && x + cell.width <= clip.x1) {
    row[x] = cell;
    for (let covered = 1; covered < cell.width; covered += 1) row[x + covered] = COVERED;
    return;
  }
  const blank: Cell = { ...cell, text: " ", width: 1 };
  for (let column = Math.max(x, clip.x0); column < Math.min(x + cell.width, clip.x1); column += 1) {
    row[column] = blank;
  }
};

const paintBorder = (
  grid: Array<Array<Slot>>,
  clip: Rect,
  rect: Rect,
  border: NonNullable<BoxNode["border"]>,
  repertoire: Repertoire,
): void => {
  const glyphs = repertoire.borders[border.style];
  const cellOf = (glyph: string): Cell => ({ text: glyph, width: width(glyph), tone: border.tone });
  const { x0, y0, x1, y1 } = rect;
  for (let x = x0 + 1; x < x1 - 1; x += 1) {
    put(grid, clip, x, y0, cellOf(glyphs.horizontal));
    put(grid, clip, x, y1 - 1, cellOf(glyphs.horizontal));
  }
  for (let y = y0 + 1; y < y1 - 1; y += 1) {
    put(grid, clip, x0, y, cellOf(glyphs.vertical));
    put(grid, clip, x1 - 1, y, cellOf(glyphs.vertical));
  }
  put(grid, clip, x0, y0, cellOf(glyphs.topLeft));
  put(grid, clip, x1 - 1, y0, cellOf(glyphs.topRight));
  put(grid, clip, x0, y1 - 1, cellOf(glyphs.bottomLeft));
  put(grid, clip, x1 - 1, y1 - 1, cellOf(glyphs.bottomRight));
};

interface Paint {
  readonly grid: Array<Array<Slot>>;
  readonly repertoire: Repertoire;
  readonly text: TextLines;
}

const paintNode = (
  paint: Paint,
  placed: Placed,
  originX: number,
  originY: number,
  clip: Rect,
): void => {
  const left = originX + placed.left;
  const top = originY + placed.top;
  const rect: Rect = {
    x0: snap(left),
    y0: snap(top),
    x1: snap(left + placed.width),
    y1: snap(top + placed.height),
  };
  const visible = intersect(clip, rect);
  const { node } = placed;
  if (node._tag === "Text") {
    // Yoga measured this leaf at the floor of its width, so wrapping at it again repeats that.
    const lines = paint.text.lines(node, Math.floor(placed.width));
    for (const [index, line] of lines.entries()) {
      let x = rect.x0;
      for (const cell of line) {
        put(paint.grid, visible, x, rect.y0 + index, cell);
        x += cell.width;
      }
    }
    return;
  }
  if (node.border !== undefined)
    paintBorder(paint.grid, visible, rect, node.border, paint.repertoire);
  const content =
    node.border === undefined
      ? visible
      : intersect(visible, {
          x0: rect.x0 + 1,
          y0: rect.y0 + 1,
          x1: rect.x1 - 1,
          y1: rect.y1 - 1,
        });
  for (const child of placed.children) paintNode(paint, child, left, top, content);
};

/**
 * Re-segments an assembled row so graphemes formed across cell boundaries are measured whole,
 * then drops what no longer fits.
 */
const fitRow = (cells: CellLine, columns: number): CellLine => {
  const joined = cellsOfPieces(cells.map((cell) => ({ text: cell.text, style: styleOf(cell) })));
  const fitted: Array<Cell> = [];
  let used = 0;
  for (const cell of joined) {
    if (used + cell.width > columns) break;
    fitted.push(cell);
    used += cell.width;
  }
  return fitted;
};

const rowCells = (row: ReadonlyArray<Slot>): Array<Cell> => {
  let end = row.length;
  while (end > 0 && row[end - 1] === undefined) end -= 1;
  const cells: Array<Cell> = [];
  for (const slot of row.slice(0, end)) {
    if (slot !== COVERED) cells.push(slot ?? SPACE);
  }
  return cells;
};

/**
 * Paints a placed tree into a grid as tall as the tree and `columns` wide, then reads it back as
 * rows of cells with trailing unpainted cells trimmed. Boxes clip their descendants to the inside
 * of their border, and the grid clips the whole tree.
 */
export const paintGrid = (
  placed: Placed | undefined,
  { columns, repertoire, text }: { columns: number; repertoire: Repertoire; text: TextLines },
): ReadonlyArray<CellLine> => {
  if (placed === undefined) return [];
  const rows = snap(placed.top + placed.height);
  const grid: Array<Array<Slot>> = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, (): Slot => undefined),
  );
  paintNode({ grid, repertoire, text }, placed, 0, 0, { x0: 0, y0: 0, x1: columns, y1: rows });
  return grid.map((row) => fitRow(rowCells(row), columns));
};
