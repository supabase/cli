import type { Command, HelpDoc } from "effect/cli";
import type { CommandHeader } from "../output/output.layer.ts";
import { withRemoteFlagUsage } from "../output/target-help.ts";
import { helpDocFor } from "./subcommand-flag-suggestions.ts";

// Get HelpDoc from a command (uses internal buildHelpDoc)
export function getHelpDoc(
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): HelpDoc.HelpDoc {
  const helpDoc = helpDocFor(command, commandPath);
  if (helpDoc === undefined) throw new Error(`Command ${command.name} has no help doc`);
  return withRemoteFlagUsage(helpDoc);
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

/**
 * The header for the command `tokens` invoke among the root's `commands`, matched by name or alias
 * up to the first token that names no subcommand. `undefined` when no described command matches.
 */
export function commandHeaderFor(
  commands: ReadonlyArray<Command.Command.Any>,
  tokens: ReadonlyArray<string>,
): CommandHeader | undefined {
  let candidates = commands;
  let current: Command.Command.Any | undefined;
  const path: Array<string> = [];
  for (const token of tokens) {
    const next = candidates.find((command) => command.name === token || command.alias === token);
    if (next === undefined) break;
    current = next;
    candidates = next.subcommands.flatMap((group) => group.commands);
    path.push(next.name);
  }
  if (current === undefined) return undefined;
  const description = current.shortDescription ?? current.description?.split("\n")[0];
  return description ? { path: path.join(" "), description } : undefined;
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
