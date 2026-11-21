import type { Color, ThemeSpec } from "../theme/public.ts";

const supabaseGreen: Color = { hex: "#3ECF8E", ansi256: 78, ansi16: "green" };

// Tones come from the Supabase `packages/ui` dark-theme tokens.
export const supabaseTheme: ThemeSpec = {
  tones: {
    muted: { hex: "#898989", ansi256: 245, ansi16: "brightBlack" },
    accent: supabaseGreen,
    success: supabaseGreen,
    warning: { hex: "#DB8E00", ansi256: 172, ansi16: "yellow" },
    danger: { hex: "#E54D2E", ansi256: 167, ansi16: "red" },
    info: { hex: "#7A66FF", ansi256: 99, ansi16: "magenta" },
  },
};
