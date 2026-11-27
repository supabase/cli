/** A symbol with an ASCII stand-in for terminals without Unicode. */
export interface Glyph {
  readonly unicode: string;
  readonly ascii: string;
}

export const glyphs = {
  tick: { unicode: "✔", ascii: "+" },
  cross: { unicode: "✖", ascii: "x" },
  warning: { unicode: "▲", ascii: "!" },
  bullet: { unicode: "•", ascii: "*" },
  radioOn: { unicode: "●", ascii: ">" },
  radioOff: { unicode: "○", ascii: " " },
  stepActive: { unicode: "◆", ascii: "*" },
  stepSubmitted: { unicode: "◇", ascii: "o" },
  bar: { unicode: "│", ascii: "|" },
  barEnd: { unicode: "└", ascii: "-" },
} as const satisfies Record<string, Glyph>;

export const spinnerFrames: ReadonlyArray<Glyph> = [
  ["⠋", "-"],
  ["⠙", "\\"],
  ["⠹", "|"],
  ["⠸", "/"],
  ["⠼", "-"],
  ["⠴", "\\"],
  ["⠦", "|"],
  ["⠧", "/"],
  ["⠇", "-"],
  ["⠏", "\\"],
].map(([unicode, ascii]) => ({ unicode: unicode ?? "", ascii: ascii ?? "" }));

export const pick = (glyph: Glyph, unicode: boolean): string =>
  unicode ? glyph.unicode : glyph.ascii;
