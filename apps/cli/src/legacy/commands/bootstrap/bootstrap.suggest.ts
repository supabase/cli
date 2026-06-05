import { relative } from "node:path";

/**
 * Reproduces Go's `suggestAppStart` (`apps/cli-go/internal/bootstrap/bootstrap.go`).
 *
 * Builds the "To start your app:" hint printed at the end of bootstrap. Go computes
 * the relative path from the original working directory (`utils.CurrentDirAbs`) to
 * the (post-chdir) project directory; a non-trivial relative path adds a `cd <rel>`
 * line, and a non-empty start command adds a second line.
 *
 * Colour is applied via the injected `colorize` callback (Go wraps each command
 * line in `utils.Aqua`). It defaults to identity so unit tests assert the raw text,
 * matching Go's `TestSuggestAppStart` which runs under a non-TTY (uncoloured) profile.
 */
export function suggestAppStart(
  currentDirAbs: string,
  workdir: string,
  command: string,
  colorize: (line: string) => string = (line) => line,
): string {
  const rel = relative(currentDirAbs, workdir);
  const lines: Array<string> = [];
  if (rel.length > 0 && rel !== ".") {
    lines.push(`cd ${rel}`);
  }
  if (command.length > 0) {
    lines.push(command);
  }
  let suggestion = "To start your app:";
  for (const line of lines) {
    suggestion += `\n  ${colorize(line)}`;
  }
  return suggestion;
}
