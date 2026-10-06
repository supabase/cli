import type { Command } from "effect/unstable/cli";

import { rootCommandForFeatures } from "../../src/cli/root.ts";
import {
  commandInternals,
  flattenSubcommands,
  userGlobalFlagParams,
} from "../../src/docs/docs-introspection.ts";
import { unwrapToSingleParam } from "../../src/command-internal/param-introspection.ts";
import type { PermissionVariant } from "../../src/command-internal/command-permissions/registry.ts";

export function flagNames(params: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return (params as Array<Parameters<typeof unwrapToSingleParam>[0]>).map((param) => {
    const name = unwrapToSingleParam(param)?.name;
    if (name === undefined) {
      throw new Error(
        "command-flags.ts: a flag param wraps an unrecognized Param variant — effect's Param union may have changed.",
      );
    }
    return name;
  });
}

/** A command's own flags: `config.flags`, `contextConfig.flags` (`withSharedFlags`), and whatever it registers via `withGlobalFlags` (e.g. `seed`'s persistent `--linked`/`--local`). */
function ownFlagsOf(command: Command.Command.Any): ReadonlyArray<string> {
  const internals = commandInternals(command);
  return [
    ...flagNames(internals.config.flags),
    ...flagNames(internals.contextConfig.flags),
    ...flagNames(userGlobalFlagParams(command)),
  ];
}

export interface TreeNode {
  readonly command: Command.Command.Any;
  /** The node's own flags plus every flag inherited from its ancestors, root included. */
  readonly flags: ReadonlySet<string>;
  readonly isLeaf: boolean;
}

function walk(
  command: Command.Command.Any,
  path: ReadonlyArray<string>,
  inherited: ReadonlyArray<string>,
  out: Map<string, TreeNode>,
): void {
  const flags = [...inherited, ...ownFlagsOf(command)];
  const children = flattenSubcommands(command);
  out.set(path.join(" "), { command, flags: new Set(flags), isLeaf: children.length === 0 });
  for (const child of children) walk(child, [...path, child.name], flags, out);
}

/** Every command in the `variant` tree, keyed by its space-separated path, with the flags it accepts. */
export function commandTreeFor(variant: PermissionVariant): ReadonlyMap<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  const root = rootCommandForFeatures(variant);
  // The root's own global flags (`--output`, `--debug`, …) apply to every command but never
  // appear on any child node, so they seed the walk instead of being discovered by it.
  const rootFlags = ownFlagsOf(root);
  for (const child of flattenSubcommands(root)) walk(child, [child.name], rootFlags, out);
  return out;
}
