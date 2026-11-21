/** Color depth: none, 16 colors, 256 colors, or 24-bit truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

/** A terminal or viewport size in character cells. */
export interface Size {
  readonly columns: number;
  readonly rows: number;
}

/** What the attached terminal can do, detected once per Terminal layer. */
export interface Capabilities {
  /** Color depth; `NO_COLOR` sets it to 0 without turning off `isStyled`. */
  readonly colorLevel: ColorLevel;
  /** SGR styling such as bold and underline may be emitted: false for pipes and `TERM=dumb` unless forced. */
  readonly isStyled: boolean;
  readonly unicode: boolean;
  readonly output: Size & { readonly isTTY: boolean };
  readonly input: { readonly isTTY: boolean };
  /** Output is a TTY and `TERM` is not `dumb`: cursor control and live redraw are allowed. */
  readonly live: boolean;
  /** Input is a TTY and output is live: prompts can run. */
  readonly interactive: boolean;
}
