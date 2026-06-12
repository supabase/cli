/**
 * Reproduces Go's `utils.Bold` (`apps/cli-go/internal/utils/colors.go:26`), which
 * renders a string with lipgloss `Bold(true)`.
 *
 * lipgloss emits ANSI only when its output stream is detected as a TTY (termenv's
 * color profile is `Ascii` — no escapes — when stdout is not a terminal, e.g. when
 * piped or captured in e2e). lipgloss's default renderer keys this off **stdout**,
 * regardless of which stream the bolded text is ultimately written to, so callers
 * pass `Tty.stdoutIsTty` here even when the text goes to stderr (as `inspect report`
 * does for "Reports saved to <bold>").
 *
 * - TTY  → wrap in SGR bold (`\x1b[1m … \x1b[0m`).
 * - non-TTY → return the string unchanged (matching termenv's `Ascii` profile).
 */
export function legacyBold(text: string, isTty: boolean): string {
  return isTty ? `\x1b[1m${text}\x1b[0m` : text;
}
