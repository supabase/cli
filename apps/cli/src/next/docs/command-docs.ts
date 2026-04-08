import type { Command, HelpDoc } from "effect/unstable/cli";

// Get HelpDoc from a command (uses internal buildHelpDoc)
export function getHelpDoc(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): HelpDoc.HelpDoc {
  return (command as any).buildHelpDoc(commandPath);
}

// Navigate to a subcommand by path segments
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

// Collect all commands in the tree (returns flat list of {command, commandPath})
export function collectCommands(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): Array<{ command: Command.Command.Any; commandPath: ReadonlyArray<string> }> {
  const results = [{ command, commandPath }];
  for (const group of command.subcommands) {
    for (const sub of group.commands) {
      results.push(...collectCommands(sub, [...commandPath, sub.name]));
    }
  }
  return results;
}
