import { Context, Layer } from "effect";

import type { Tone } from "../view/node.ts";

/** The 16-color palette, addressed by name. */
export type AnsiColorName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/**
 * One color with a fallback for each color depth. A color without `hex` or `ansi256` uses the
 * 16-color name at those depths, so it follows the terminal's own palette.
 */
export type Color = Readonly<{
  /** Truecolor, `#rrggbb`. */
  hex?: string;
  /** 256-color palette index. */
  ansi256?: number;
  ansi16: AnsiColorName;
}>;

/** Tones a run renders with; glyphs belong to the program and the renderer, not the theme. */
export interface ThemeSpec {
  /** `default` has no entry: it is the terminal's own foreground. */
  readonly tones: Readonly<Record<Exclude<Tone, "default">, Color>>;
}

/** Tones from the terminal's own 16-color palette, so output follows the user's terminal theme. */
export const defaultTheme: ThemeSpec = {
  tones: {
    muted: { ansi16: "brightBlack" },
    accent: { ansi16: "cyan" },
    success: { ansi16: "green" },
    warning: { ansi16: "yellow" },
    danger: { ansi16: "red" },
    info: { ansi16: "blue" },
  },
};

/** The theme a run renders with; `defaultTheme` unless the host provides another. */
export const Current = Context.Reference<ThemeSpec>("@supabase/tui/Theme", {
  defaultValue: () => defaultTheme,
});

/** Selects the theme for runs that read this layer. */
export const layer = (spec: ThemeSpec): Layer.Layer<never> => Layer.succeed(Current, spec);
