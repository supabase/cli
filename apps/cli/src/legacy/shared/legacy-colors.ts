import { styleText } from "node:util";

/**
 * Ports of Go's `utils.Aqua` / `utils.Bold` (`apps/cli-go/internal/utils/colors.go`).
 *
 * Go uses lipgloss, which auto-detects the output profile and renders **plain**
 * text when the stream is not a TTY (piped output, CI, tests). `styleText`
 * mirrors that: with `validateStream` (the default) it checks the target stream
 * and `NO_COLOR`, returning the unstyled string when colour is unsupported. We
 * point it at `process.stderr` because the bootstrap progress / suggestion lines
 * these style are written to stderr.
 *
 * lipgloss colour "14" is bright cyan; `"cyan"` is the closest faithful match,
 * matching `branches.prompt.ts`'s existing port of `utils.Aqua`.
 */
export function legacyAqua(text: string): string {
  return styleText("cyan", text, { stream: process.stderr });
}

export function legacyBold(text: string): string {
  return styleText("bold", text, { stream: process.stderr });
}

/** Port of Go's `utils.Yellow` — lipgloss colour "11" (bright yellow). */
export function legacyYellow(text: string): string {
  return styleText("yellow", text, { stream: process.stderr });
}

/** Port of Go's `utils.Red` — lipgloss colour "9" (bright red). */
export function legacyRed(text: string): string {
  return styleText("red", text, { stream: process.stderr });
}
