import { TerminalTheme } from "@supabase/ui-terminal";

/** Tones in the Supabase palette, with 256-color and 16-color fallbacks. */
export const supabaseTheme: TerminalTheme.ThemeSpec = {
  tones: {
    muted: { hex: "#898989", ansi256: 245, ansi16: "brightBlack" },
    accent: { hex: "#3ECF8E", ansi256: 78, ansi16: "green" },
    success: { hex: "#3ECF8E", ansi256: 78, ansi16: "green" },
    warning: { hex: "#DB8E00", ansi256: 172, ansi16: "yellow" },
    danger: { hex: "#E54D2E", ansi256: 166, ansi16: "red" },
    info: { hex: "#7A66FF", ansi256: 99, ansi16: "magenta" },
  },
};
