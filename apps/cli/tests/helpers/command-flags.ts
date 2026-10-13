import type { Command } from "effect/cli";

import { rootCommandForFeatures } from "../../src/cli/root.ts";
import {
  choiceKeysOf,
  commandInternals,
  flattenSubcommands,
  userGlobalFlagParams,
} from "../../src/docs/docs-introspection.ts";
import { unwrapParam } from "../../src/command-internal/param-introspection.ts";
import type { PermissionVariant } from "./permission-registry.ts";

interface FlagInfo {
  /** A switch takes no value: test it with `is` when it has a default, `present` when it's optional. */
  readonly isBoolean: boolean;
  /** Declared with `Flag.optional`, so the handler can tell "not given" from a value; a `Flag.withDefault` flag is not. */
  readonly isOptional: boolean;
  /** The values a choice flag accepts; `undefined` for a free-form value. */
  readonly choices: ReadonlyArray<string> | undefined;
}

function unwrappedParamsOf(params: ReadonlyArray<unknown>): ReadonlyArray<{
  single: NonNullable<ReturnType<typeof unwrapParam>>["single"];
  isOptional: boolean;
}> {
  return (params as Array<Parameters<typeof unwrapParam>[0]>).map((param) => {
    const unwrapped = unwrapParam(param);
    if (unwrapped === undefined) {
      throw new Error(
        "command-flags.ts: a flag param wraps an unrecognized Param variant — effect's Param union may have changed.",
      );
    }
    return { single: unwrapped.single, isOptional: param._tag === "Optional" };
  });
}

export function flagNames(params: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return unwrappedParamsOf(params).map(({ single }) => single.name);
}

/** A command's own flags: `config.flags`, `contextConfig.flags` (`withSharedFlags`), and whatever it registers via `withGlobalFlags` (e.g. `seed`'s persistent `--linked`/`--local`). */
function ownFlagsOf(command: Command.Command.Any): ReadonlyArray<readonly [string, FlagInfo]> {
  const internals = commandInternals(command);
  return unwrappedParamsOf([
    ...internals.config.flags,
    ...internals.contextConfig.flags,
    ...userGlobalFlagParams(command),
  ]).map(({ single, isOptional }) => [
    single.name,
    {
      isBoolean: single.primitiveType._tag === "Boolean",
      isOptional,
      choices: choiceKeysOf(single.primitiveType),
    },
  ]);
}

export interface TreeNode {
  readonly command: Command.Command.Any;
  /** The node's own flags plus every flag inherited from its ancestors, root included. */
  readonly flags: ReadonlySet<string>;
  /** What each of {@link flags} accepts; a node's own definition wins over an inherited one of the same name. */
  readonly flagInfo: ReadonlyMap<string, FlagInfo>;
  readonly isLeaf: boolean;
}

function walk(
  command: Command.Command.Any,
  path: ReadonlyArray<string>,
  inherited: ReadonlyArray<readonly [string, FlagInfo]>,
  out: Map<string, TreeNode>,
): void {
  const flags = [...inherited, ...ownFlagsOf(command)];
  const flagInfo = new Map(flags);
  const children = flattenSubcommands(command);
  out.set(path.join(" "), {
    command,
    flags: new Set(flagInfo.keys()),
    flagInfo,
    isLeaf: children.length === 0,
  });
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
