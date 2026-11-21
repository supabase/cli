import type { Glyph } from "../view/public.ts";

/** The glyphs the blocks draw, each with an ASCII alternate for terminals without unicode. */
export const glyphs = {
  tick: { unicode: "✔", ascii: "+" },
  cross: { unicode: "✖", ascii: "x" },
  warning: { unicode: "▲", ascii: "!" },
  pointer: { unicode: "❯", ascii: ">" },
  bullet: { unicode: "•", ascii: "*" },
  radioOn: { unicode: "●", ascii: ">" },
  radioOff: { unicode: "○", ascii: " " },
  stepActive: { unicode: "◆", ascii: "*" },
  stepSubmitted: { unicode: "◇", ascii: "o" },
  bar: { unicode: "│", ascii: "|" },
  barEnd: { unicode: "└", ascii: "-" },
} satisfies Record<string, Glyph>;
