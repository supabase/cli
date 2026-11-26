import { normalize } from "./text.ts";
import { isPlainAscii, segmentGraphemes, width } from "./width.ts";

/** One grapheme with its display width. */
export interface Cell {
  readonly text: string;
  readonly width: number;
}

type CellLine = ReadonlyArray<Cell>;

const cellsOf = (text: string): Array<Cell> =>
  isPlainAscii(text)
    ? Array.from(text, (char) => ({ text: char, width: 1 }))
    : segmentGraphemes(text).map((part) => ({ text: part.text, width: width(part.text) }));

const lineWidth = (line: CellLine): number => line.reduce((total, cell) => total + cell.width, 0);

const isSpace = (cell: Cell): boolean => cell.text === " ";

const trimEnd = (cells: ReadonlyArray<Cell>): ReadonlyArray<Cell> => {
  let end = cells.length;
  while (end > 0 && cells.at(end - 1)?.text === " ") end -= 1;
  return cells.slice(0, end);
};

interface Token {
  readonly cells: Array<Cell>;
  readonly space: boolean;
  readonly width: number;
}

const tokenize = (cells: ReadonlyArray<Cell>): Array<Token> => {
  const tokens: Array<Token> = [];
  let open: { cells: Array<Cell>; space: boolean } | undefined;
  const close = (): void => {
    if (open !== undefined) tokens.push({ ...open, width: lineWidth(open.cells) });
    open = undefined;
  };
  for (const cell of cells) {
    const space = isSpace(cell);
    if (open !== undefined && open.space !== space) close();
    open ??= { cells: [], space };
    open.cells.push(cell);
  }
  close();
  return tokens;
};

const wrapParagraph = (cells: ReadonlyArray<Cell>, columns: number): Array<CellLine> => {
  const lines: Array<CellLine> = [];
  let current: Array<Cell> = [];
  let currentWidth = 0;
  const flush = (): void => {
    const trimmed = trimEnd(current);
    if (trimmed.length > 0) lines.push(trimmed);
    current = [];
    currentWidth = 0;
  };
  const place = (cell: Cell): void => {
    current.push(cell);
    currentWidth += cell.width;
  };

  const tokens = tokenize(cells);
  for (const [index, token] of tokens.entries()) {
    if (token.space) {
      if (current.length === 0 && lines.length > 0) continue;
      const trailing = index === tokens.length - 1;
      if (!trailing && current.length > 0 && currentWidth + token.width > columns) flush();
      else for (const cell of token.cells) if (currentWidth + cell.width <= columns) place(cell);
    } else if (currentWidth + token.width <= columns) {
      for (const cell of token.cells) place(cell);
    } else {
      flush();
      for (const cell of token.cells) {
        if (cell.width > columns) continue;
        if (currentWidth + cell.width > columns) flush();
        place(cell);
      }
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
};

const ELLIPSIS: Cell = { text: "…", width: 1 };

/** Cuts `line` to `columns` cells, ending with an ellipsis when something was cut. */
const truncateLine = (line: CellLine, columns: number): CellLine => {
  if (lineWidth(line) <= columns) return line;
  if (columns < 1) return [];
  const kept: Array<Cell> = [];
  let used = 0;
  for (const cell of line) {
    if (used + cell.width > columns - 1) break;
    kept.push(cell);
    used += cell.width;
  }
  return [...kept, ELLIPSIS];
};

/**
 * Normalized, measured text; wrapped lines are cached per width. Lines wrap at word boundaries,
 * or with `truncate` stay one row each.
 */
export interface TextLines {
  /** Width of the widest hard line, before any wrapping. */
  readonly natural: number;
  /** The lines at `columns` cells; none when there is content but no room. */
  readonly lines: (columns: number) => ReadonlyArray<CellLine>;
}

export const makeTextLines = (text: string, truncate = false): TextLines => {
  const hard = normalize(text).split("\n").map(cellsOf);
  const natural = hard.reduce((most, line) => Math.max(most, lineWidth(line)), 0);
  const byWidth = new Map<number, ReadonlyArray<CellLine>>();
  const lines = (columns: number): ReadonlyArray<CellLine> => {
    const cached = byWidth.get(columns);
    if (cached !== undefined) return cached;
    const laidOut =
      columns < 1 && natural > 0
        ? []
        : truncate
          ? hard.map((line) => truncateLine(line, columns))
          : hard.flatMap((line) => wrapParagraph(line, columns));
    byWidth.set(columns, laidOut);
    return laidOut;
  };
  return { natural, lines };
};
