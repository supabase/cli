import { relative } from "node:path";

/**
 * Builds the "To start your app:" hint printed at the end of bootstrap: a `cd <rel>` line when
 * the project directory differs from the original cwd, then the start command if non-empty.
 *
 * `colorize` defaults to identity so unit tests can assert raw, uncoloured text.
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
