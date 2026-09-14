/**
 * Renders text bold for a TTY, unchanged otherwise.
 *
 * Callers pass `Tty.stdoutIsTty` here even when the bolded text is written to stderr (e.g.
 * `inspect report`'s "Reports saved to <bold>"), since whether bolding is enabled is keyed off
 * stdout, not the destination stream.
 */
export function bold(text: string, isTty: boolean): string {
  return isTty ? `\x1b[1m${text}\x1b[0m` : text;
}
