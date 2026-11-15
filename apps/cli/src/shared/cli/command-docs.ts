import type { Command } from "effect/cli";
export function findCommand(
  root: Command.Command.Any,
  path: ReadonlyArray<string>,
): Command.Command.Any | undefined {
  let current = root;
  for (const segment of path) {
    let found: Command.Command.Any | undefined;
    for (const group of current.subcommands) {
      for (const cmd of group.commands) {
        if (cmd.name === segment) {
          found = cmd;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return undefined;
    current = found;
  }
  return current;
}
