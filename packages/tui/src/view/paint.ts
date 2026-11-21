import type { ColorLevel } from "../capabilities.ts";
import type { AnsiColorName, Color, ThemeSpec } from "../theme/theme.ts";
import type { Line, Segment } from "./layout.ts";
import type { Emphasis } from "./node.ts";

export interface PaintOptions {
  /** Emphasis is emitted only when styling is allowed. */
  readonly isStyled: boolean;
  /** Tone colors are emitted only above level 0. */
  readonly colorLevel: ColorLevel;
  readonly theme: ThemeSpec;
}

const ESC = "\u001b";
const RESET = `${ESC}[0m`;

const EMPHASIS_CODES: Readonly<Record<Emphasis, number>> = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
};

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

const paintSegment = (segment: Segment, { isStyled, colorLevel, theme }: PaintOptions): string => {
  if (!isStyled || segment.text === "") return segment.text;
  const codes: Array<string> = [];
  if (segment.emphasis !== undefined) codes.push(String(EMPHASIS_CODES[segment.emphasis]));
  if (colorLevel !== 0 && segment.tone !== undefined && segment.tone !== "default") {
    codes.push(colorCodes(theme.tones[segment.tone], colorLevel));
  }
  return codes.length === 0 ? segment.text : `${ESC}[${codes.join(";")}m${segment.text}${RESET}`;
};

/** Serializes one line to text with SGR styling; never emits cursor sequences. */
export const paint = (line: Line, options: PaintOptions): string =>
  line.map((segment) => paintSegment(segment, options)).join("");
