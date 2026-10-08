import { Context, Option } from "effect";
import type { Command, Param } from "effect/unstable/cli";

import { unwrapParam } from "../../src/command-internal/param-introspection.ts";
import { commandInternals, flattenSubcommands } from "../../src/docs/docs-introspection.ts";
import {
  CliConfigFlagBindings,
  type CliConfigFlagBinding,
} from "../../src/config/cli-config-flags.ts";

interface WalkedFlag {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly param: Param.AnyFlag;
}

export interface WalkedCommand {
  readonly path: ReadonlyArray<string>;
  readonly command: Command.Command.Any;
  readonly flags: ReadonlyArray<WalkedFlag>;
  readonly bindings: ReadonlyArray<CliConfigFlagBinding>;
}

/** Every command under `root` with its own declared flags and `withCliConfigFlags` bindings. */
export const walkCommandTree = (root: Command.Command.Any): ReadonlyArray<WalkedCommand> => {
  const out: Array<WalkedCommand> = [];
  const visit = (command: Command.Command.Any, path: ReadonlyArray<string>): void => {
    const flags = commandInternals(command).config.flags.flatMap((param): Array<WalkedFlag> => {
      const single = unwrapParam(param)?.single;
      return single === undefined
        ? []
        : [{ name: single.name, aliases: single.aliases ?? [], param }];
    });
    out.push({
      path,
      command,
      flags,
      bindings: Option.getOrElse(
        Context.getOption(command.annotations, CliConfigFlagBindings),
        () => [],
      ),
    });
    for (const child of flattenSubcommands(command)) visit(child, [...path, child.name]);
  };
  visit(root, []);
  return out;
};
