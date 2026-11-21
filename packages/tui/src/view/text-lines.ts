import type { Emphasis, Span, TextNode, Tone } from "./node.ts";
import { repertoireFor } from "./repertoire.ts";
import { normalize } from "./text.ts";
import { segmentGraphemes, width } from "./width.ts";

export interface Style {
  readonly tone?: Tone;
  readonly emphasis?: Emphasis;
}

/** One grapheme with its style and display width. */
export interface Cell extends Style {
  readonly text: string;
  readonly width: number;
}

export type CellLine = ReadonlyArray<Cell>;

export const natural = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export interface Piece {
  readonly text: string;
  readonly style: Style;
}

/** Segments the joined text so a grapheme spanning two pieces stays whole, in its first piece's style. */
export const cellsOfPieces = (pieces: ReadonlyArray<Piece>): Array<Cell> => {
  const cells: Array<Cell> = [];
  let pieceIndex = 0;
  let pieceEnd = pieces[0]?.text.length ?? 0;
  for (const { text, index } of segmentGraphemes(pieces.map((piece) => piece.text).join(""))) {
    while (index >= pieceEnd && pieceIndex < pieces.length - 1) {
      pieceIndex += 1;
      pieceEnd += pieces[pieceIndex]?.text.length ?? 0;
    }
    cells.push({ text, width: width(text), ...pieces[pieceIndex]?.style });
  }
  return cells;
};

const cellsOf = (text: string, style: Style): Array<Cell> => cellsOfPieces([{ text, style }]);

const lineWidth = (line: CellLine): number => line.reduce((total, cell) => total + cell.width, 0);

const widest = (lines: ReadonlyArray<CellLine>): number =>
  lines.reduce((most, line) => Math.max(most, lineWidth(line)), 0);

/**
 * Cell width of the widest hard line of `text` after the renderer's normalization (escape
 * sequences removed, tabs expanded, controls replaced), which is the width layout will draw.
 */
export const widestLine = (text: string): number =>
  widest(
    normalize(text)
      .split("\n")
      .map((line) => cellsOf(line, {})),
  );

const isSpace = (cell: Cell): boolean => cell.text === " ";

export const styleOf = (span: Span): Style => ({
  ...(span.tone === undefined ? {} : { tone: span.tone }),
  ...(span.emphasis === undefined ? {} : { emphasis: span.emphasis }),
});

/** Splits spans into hard lines of cells; text and glyphs are normalized, glyphs resolved by `unicode`. */
const hardLines = (spans: ReadonlyArray<Span>, unicode: boolean): Array<Array<Cell>> => {
  let current: Array<Piece> = [];
  const lines = [current];
  let column = 0;
  const add = (text: string, style: Style): void => {
    current.push({ text, style });
    column += width(text);
  };
  const addNormalized = (text: string, style: Style): void => {
    for (const [index, part] of normalize(text, column).split("\n").entries()) {
      if (index > 0) {
        current = [];
        lines.push(current);
        column = 0;
      }
      add(part, style);
    }
  };
  for (const span of spans) {
    const style = styleOf(span);
    if (span.glyph !== undefined)
      addNormalized(unicode ? span.glyph.unicode : span.glyph.ascii, style);
    addNormalized(span.text, style);
  }
  return lines.map(cellsOfPieces);
};

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

const truncateParagraph = (
  cells: ReadonlyArray<Cell>,
  columns: number,
  ellipsis: string,
): CellLine => {
  if (lineWidth(cells) <= columns) return cells;
  const ellipsisWidth = width(ellipsis);
  const showEllipsis = ellipsisWidth <= columns;
  const budget = showEllipsis ? columns - ellipsisWidth : columns;
  const kept: Array<Cell> = [];
  let used = 0;
  for (const cell of cells) {
    if (used + cell.width > budget) break;
    kept.push(cell);
    used += cell.width;
  }
  if (!showEllipsis) return kept;
  const anchor = kept.at(-1) ?? cells.at(0);
  return [...kept, ...cellsOf(ellipsis, anchor === undefined ? {} : styleOf(anchor))];
};

interface Entry {
  readonly hard: ReadonlyArray<CellLine>;
  readonly natural: number;
  readonly byWidth: Map<number, ReadonlyArray<CellLine>>;
}

/** Text lines for one layout pass: wrapped lines are cached per node and width. */
export interface TextLines {
  /** Width of the widest hard line, before any wrapping or truncating. */
  readonly natural: (node: TextNode) => number;
  /** The node's lines at `columns` cells; none when it has content but no room. */
  readonly lines: (node: TextNode, columns: number) => ReadonlyArray<CellLine>;
}

export const makeTextLines = (unicode: boolean): TextLines => {
  const { ellipsis } = repertoireFor(unicode);
  const entries = new Map<TextNode, Entry>();
  const entryOf = (node: TextNode): Entry => {
    const cached = entries.get(node);
    if (cached !== undefined) return cached;
    const hard = hardLines(node.spans, unicode);
    const entry: Entry = {
      hard,
      natural: widest(hard),
      byWidth: new Map(),
    };
    entries.set(node, entry);
    return entry;
  };
  const lines = (node: TextNode, columns: number): ReadonlyArray<CellLine> => {
    const entry = entryOf(node);
    const cached = entry.byWidth.get(columns);
    if (cached !== undefined) return cached;
    const laidOut =
      columns < 1 && entry.natural > 0
        ? []
        : entry.hard.flatMap((line) =>
            node.wrap ? wrapParagraph(line, columns) : [truncateParagraph(line, columns, ellipsis)],
          );
    entry.byWidth.set(columns, laidOut);
    return laidOut;
  };
  return { natural: (node) => entryOf(node).natural, lines };
};
