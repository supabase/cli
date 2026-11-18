import { Array as Arr } from "effect";
import type { Command, HelpDoc } from "effect/cli";
import { deprecatedShortDescription } from "../../command-internal/command-access-policy.ts";

/** The usage starts with the command path, root first, followed by placeholders. */
export function commandForDoc(
  root: Command.Command.Any,
  doc: HelpDoc.HelpDoc,
): Command.Command.Any | undefined {
  let current = root;
  for (const token of doc.usage.split(" ").slice(1)) {
    if (token.startsWith("<") || token.startsWith("[")) break;
    const next = current.subcommands
      .flatMap((group) => group.commands)
      .find((command) => command.name === token || command.alias === token);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/** Effect omits child annotations from help rows, so resolve their labels from the command tree. */
export function withDeprecatedDescriptions(
  doc: HelpDoc.HelpDoc,
  root: Command.Command.Any | undefined,
): HelpDoc.HelpDoc {
  if (!root || !doc.subcommands) return doc;
  const parent = commandForDoc(root, doc);
  if (!parent) return doc;
  const labels = new Map<string, string>();
  for (const child of parent.subcommands.flatMap((group) => group.commands)) {
    const label = deprecatedShortDescription(child);
    if (label !== undefined) labels.set(child.name, label);
  }
  if (!labels.size) return doc;
  return {
    ...doc,
    subcommands: doc.subcommands.map((group) => ({
      ...group,
      commands: Arr.map(group.commands, (row) => {
        const shortDescription = labels.get(row.name);
        return shortDescription === undefined ? row : { ...row, shortDescription };
      }),
    })),
  };
}
