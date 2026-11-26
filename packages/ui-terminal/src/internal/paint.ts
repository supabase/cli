import { Display } from "yoga-layout/load";

import type { ColorLevel } from "./capabilities.ts";
import { ElementNode } from "./node.ts";
import type { BorderStyle } from "./node.ts";
import type { Cell } from "./text-lines.ts";
import type { AnsiColorName, Color, ThemeSpec, Tone } from "../TerminalTheme.ts";
import { width } from "./width.ts";

/** What painting needs to know about the terminal and theme. */
export interface PaintContext {
  readonly unicode: boolean;
  readonly isStyled: boolean;
  readonly colorLevel: ColorLevel;
  readonly theme: ThemeSpec;
}

interface Style {
  readonly tone: Tone;
  readonly bold: boolean;
  readonly dim: boolean;
}

interface Painted extends Cell {
  readonly style: Style;
}

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

type Slot = Painted | undefined;
type Grid = Array<Array<Slot>>;

/** The cells a wide glyph covers after its first one. */
const COVERED: Painted = {
  text: "",
  width: 0,
  style: { tone: "default", bold: false, dim: false },
};
const SPACE: Painted = { text: " ", width: 1, style: COVERED.style };

interface Glyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

const asciiBorder: Glyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
};

const borders: Readonly<Record<"unicode" | "ascii", Readonly<Record<BorderStyle, Glyphs>>>> = {
  unicode: {
    single: {
      topLeft: "┌",
      topRight: "┐",
      bottomLeft: "└",
      bottomRight: "┘",
      horizontal: "─",
      vertical: "│",
    },
    rounded: {
      topLeft: "╭",
      topRight: "╮",
      bottomLeft: "╰",
      bottomRight: "╯",
      horizontal: "─",
      vertical: "│",
    },
  },
  ascii: { single: asciiBorder, rounded: asciiBorder },
};

/** Absolute edges snap to 1/1024 of a cell first, so float32 noise never splits a shared edge. */
const snap = (edge: number): number => Math.round(Math.round(edge * 1024) / 1024);

const intersect = (a: Rect, b: Rect): Rect => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});

/** Writes `cell` at (x, y) inside `clip`; a glyph cut by the clip leaves styled spaces instead. */
const put = (grid: Grid, clip: Rect, x: number, y: number, cell: Painted): void => {
  const row = grid[y];
  if (row === undefined || y < clip.y0 || y >= clip.y1 || cell.width < 1) return;
  if (x >= clip.x0 && x + cell.width <= clip.x1) {
    row[x] = cell;
    for (let covered = 1; covered < cell.width; covered += 1) row[x + covered] = COVERED;
    return;
  }
  const blank: Painted = { ...cell, text: " ", width: 1 };
  for (let column = Math.max(x, clip.x0); column < Math.min(x + cell.width, clip.x1); column += 1) {
    row[column] = blank;
  }
};

const paintBorder = (grid: Grid, clip: Rect, rect: Rect, glyphs: Glyphs, style: Style): void => {
  const cellOf = (glyph: string): Painted => ({ text: glyph, width: width(glyph), style });
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

const paintNode = (
  grid: Grid,
  context: PaintContext,
  element: ElementNode,
  originX: number,
  originY: number,
  clip: Rect,
): void => {
  const { yoga } = element;
  if (yoga.getDisplay() === Display.None) return;
  const left = originX + yoga.getComputedLeft();
  const top = originY + yoga.getComputedTop();
  const rect: Rect = {
    x0: snap(left),
    y0: snap(top),
    x1: snap(left + yoga.getComputedWidth()),
    y1: snap(top + yoga.getComputedHeight()),
  };
  const visible = intersect(clip, rect);

  if (element.tag === "text") {
    const style: Style = { tone: element.tone(), bold: element.bold(), dim: element.dim() };
    // Yoga measured this leaf at the floor of its width, so wrapping at it again repeats that.
    const lines = element.textLines().lines(Math.floor(yoga.getComputedWidth()));
    for (const [index, line] of lines.entries()) {
      let x = rect.x0;
      for (const cell of line) {
        put(grid, visible, x, rect.y0 + index, { ...cell, style });
        x += cell.width;
      }
    }
    return;
  }

  const border = element.border();
  if (border !== undefined) {
    const glyphs = borders[context.unicode ? "unicode" : "ascii"][border];
    paintBorder(grid, visible, rect, glyphs, {
      tone: element.borderTone(),
      bold: false,
      dim: false,
    });
  }
  const content =
    border === undefined
      ? visible
      : intersect(visible, { x0: rect.x0 + 1, y0: rect.y0 + 1, x1: rect.x1 - 1, y1: rect.y1 - 1 });
  for (const child of element.children) {
    if (child instanceof ElementNode) paintNode(grid, context, child, left, top, content);
  }
};

const ESC = "\u001b";
const RESET = `${ESC}[0m`;

const ANSI_16_FOREGROUND: Readonly<Record<AnsiColorName, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};

const colorCodes = (color: Color, colorLevel: Exclude<ColorLevel, 0>): string => {
  if (colorLevel === 3 && color.hex !== undefined) {
    const { hex } = color;
    const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16);
    return `38;2;${channel(1)};${channel(3)};${channel(5)}`;
  }
  if (colorLevel >= 2 && color.ansi256 !== undefined) return `38;5;${color.ansi256}`;
  return String(ANSI_16_FOREGROUND[color.ansi16]);
};

const styled = (text: string, style: Style, { isStyled, colorLevel, theme }: PaintContext) => {
  if (!isStyled) return text;
  const codes: Array<string> = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (colorLevel !== 0 && style.tone !== "default") {
    codes.push(colorCodes(theme.tones[style.tone], colorLevel));
  }
  return codes.length === 0 ? text : `${ESC}[${codes.join(";")}m${text}${RESET}`;
};

const sameStyle = (a: Style, b: Style): boolean =>
  a.tone === b.tone && a.bold === b.bold && a.dim === b.dim;

const serializeRow = (row: ReadonlyArray<Slot>, context: PaintContext): string => {
  let end = row.length;
  while (end > 0 && row[end - 1] === undefined) end -= 1;
  let out = "";
  let run = "";
  let runStyle: Style | undefined;
  const flush = (): void => {
    if (runStyle !== undefined) out += styled(run, runStyle, context);
    run = "";
  };
  for (const slot of row.slice(0, end)) {
    if (slot === COVERED) continue;
    const cell = slot ?? SPACE;
    if (runStyle === undefined || !sameStyle(runStyle, cell.style)) {
      flush();
      runStyle = cell.style;
    }
    run += cell.text;
  }
  flush();
  return out;
};

/**
 * Paints `element` and its descendants, with `element` at the origin, into rows of text that are
 * as many as its height. Boxes clip their descendants to the inside of their border.
 */
export const paintTree = (element: ElementNode, context: PaintContext): ReadonlyArray<string> => {
  const columns = snap(element.yoga.getComputedWidth());
  const rows = snap(element.yoga.getComputedHeight());
  if (columns < 1 || rows < 1) return [];
  const grid: Grid = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, (): Slot => undefined),
  );
  paintNode(
    grid,
    context,
    element,
    -element.yoga.getComputedLeft(),
    -element.yoga.getComputedTop(),
    {
      x0: 0,
      y0: 0,
      x1: columns,
      y1: rows,
    },
  );
  return grid.map((row) => serializeRow(row, context));
};
