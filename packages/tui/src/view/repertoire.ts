import type { BorderStyle } from "./node.ts";

interface BorderGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

/** What the renderer draws itself; every border glyph is one cell wide. */
export interface Repertoire {
  readonly ellipsis: string;
  readonly borders: Readonly<Record<BorderStyle, BorderGlyphs>>;
}

const asciiBorder: BorderGlyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
};

const unicode: Repertoire = {
  ellipsis: "…",
  borders: {
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
};

const ascii: Repertoire = {
  ellipsis: "...",
  borders: { single: asciiBorder, rounded: asciiBorder },
};

export const repertoireFor = (supportsUnicode: boolean): Repertoire =>
  supportsUnicode ? unicode : ascii;
