/**
 * Tracks a run of consecutive `--debug` lines on a terminal so the run sits apart from normal
 * output, with a blank line above and below it.
 */
let open = false;
let written = false;

/** The separator to write before a debug line: a blank line when it starts a run mid-output. */
export function enterDebugRun(): string {
  const separator = open || !written ? "" : "\n";
  open = true;
  written = true;
  return separator;
}

/** Prefixes normal output with a blank line when a debug run just ended, unless it has one. */
export function leaveDebugRun(chunk = ""): string {
  written = true;
  if (!open) return "";
  open = false;
  return chunk.startsWith("\n") ? "" : "\n";
}
