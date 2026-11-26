import { Context, Layer, Schema } from "effect";

/** Semantic color role; the theme owns the actual color. */
export const Tone = Schema.Literals([
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
]);
export type Tone = typeof Tone.Type;
export const isTone = Schema.is(Tone);

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

/** Tones a run renders with; `default` has no entry: it is the terminal's own foreground. */
export interface ThemeSpec {
  readonly tones: Readonly<Record<Exclude<Tone, "default">, Color>>;
}

/** Tones drawn with the terminal's own 16-color palette, so they follow the user's color scheme. */
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

/** The theme a run renders with; `defaultTheme` unless a layer provides another. */
export const Current = Context.Reference<ThemeSpec>("@supabase/ui-terminal/TerminalTheme/Current", {
  defaultValue: () => defaultTheme,
});

/** Selects the theme for runs that read this layer. */
export const layer = (spec: ThemeSpec): Layer.Layer<never> => Layer.succeed(Current, spec);
