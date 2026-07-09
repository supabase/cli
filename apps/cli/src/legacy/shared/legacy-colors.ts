import { styleText } from "node:util";

/**
 * Ports of Go's `utils.Aqua` / `utils.Bold` (`apps/cli-go/internal/utils/colors.go`).
 *
 * Go uses lipgloss, which auto-detects the output profile and renders **plain**
 * text when the stream is not a TTY (piped output, CI, tests). `styleText`
 * mirrors that: with `validateStream` (the default) it checks the target stream
 * and `NO_COLOR`, returning the unstyled string when colour is unsupported.
 *
 * `stream` defaults to `process.stderr` because every original call site styles
 * progress/suggestion lines written to stderr. A caller styling content that is
 * itself written to **stdout** (e.g. `status`'s pretty table) must pass
 * `process.stdout` explicitly — otherwise the TTY check runs against the wrong
 * stream, and piping stdout while stderr stays a TTY (`supabase status | less`)
 * would corrupt the piped output with ANSI escapes (the same bug class CLI-1546
 * fixed for the progress spinner).
 *
 * lipgloss colour "14" is bright cyan; `"cyan"` is the closest faithful match,
 * matching `branches.prompt.ts`'s existing port of `utils.Aqua`.
 */
export function legacyAqua(text: string, stream: NodeJS.WriteStream = process.stderr): string {
  return styleText("cyan", text, { stream });
}

export function legacyBold(text: string, stream: NodeJS.WriteStream = process.stderr): string {
  return styleText("bold", text, { stream });
}

/** Port of Go's `utils.Yellow` — lipgloss colour "11" (bright yellow). */
export function legacyYellow(text: string, stream: NodeJS.WriteStream = process.stderr): string {
  return styleText("yellow", text, { stream });
}

/** Port of Go's `utils.Red` — lipgloss colour "9" (bright red). */
export function legacyRed(text: string, stream: NodeJS.WriteStream = process.stderr): string {
  return styleText("red", text, { stream });
}

/** Port of Go's `utils.Green` — lipgloss colour "10" (bright green). */
export function legacyGreen(text: string, stream: NodeJS.WriteStream = process.stderr): string {
  return styleText("green", text, { stream });
}
