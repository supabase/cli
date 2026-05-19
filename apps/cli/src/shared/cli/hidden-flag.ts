import { Context } from "effect";
import { Command, type Flag, type HelpDoc } from "effect/unstable/cli";
import * as Param from "effect/unstable/cli/Param";

/**
 * Per-command set of hidden flag names. Attached to a `Command` via
 * `Command.annotate` so each command carries its own list, then read off
 * `HelpDoc.annotations` by `stripHiddenFlagsFromHelpDoc`.
 */
export const LegacyHiddenFlags: Context.Reference<ReadonlySet<string>> = Context.Reference<
  ReadonlySet<string>
>("supabase/legacy/LegacyHiddenFlags", {
  defaultValue: () => new Set<string>(),
});

export const LegacyHiddenSubcommands: Context.Reference<ReadonlySet<string>> = Context.Reference<
  ReadonlySet<string>
>("supabase/legacy/LegacyHiddenSubcommands", {
  defaultValue: () => new Set<string>(),
});

const hiddenFlagNames = new WeakMap<object, ReadonlyArray<string>>();

const collectSingleNames = (param: Param.Param<Param.ParamKind, unknown>): Array<string> => {
  const node = param as
    | Param.Single<Param.ParamKind, unknown>
    | Param.Map<Param.ParamKind, unknown, unknown>
    | Param.Transform<Param.ParamKind, unknown, unknown>
    | Param.Optional<Param.ParamKind, unknown>
    | Param.Variadic<Param.ParamKind, unknown>;
  switch (node._tag) {
    case "Single":
      return [node.name];
    case "Map":
    case "Transform":
    case "Optional":
    case "Variadic":
      return collectSingleNames(node.param);
  }
};

/**
 * Marks a flag as hidden so that it is parsed normally but omitted from
 * `--help` output. This mirrors Cobra's `MarkHidden` from the Go CLI, which
 * the upstream Effect CLI does not yet expose natively.
 *
 * The flag reference is recorded in a module-local `WeakMap`; the
 * per-command list is materialised by `withHiddenFromConfig` so flags with
 * the same name in unrelated commands do not collide.
 */
export const withHidden = <A>(flag: Flag.Flag<A>): Flag.Flag<A> => {
  hiddenFlagNames.set(flag, collectSingleNames(flag));
  return flag;
};

/**
 * Pipe step for a `Command` that walks the command's flag config, finds
 * every flag previously wrapped with `withHidden`, and attaches the
 * resulting set of hidden flag names to the command via `Command.annotate`.
 * Apply directly after `Command.make(name, config)` so the same `config`
 * object is in scope.
 */
export const withHiddenFromConfig =
  (config: Record<string, unknown>) =>
  <Name extends string, Input, ContextInput, E, R>(
    cmd: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> => {
    const hidden = new Set<string>();
    for (const value of Object.values(config)) {
      if (value === null || typeof value !== "object") continue;
      const names = hiddenFlagNames.get(value);
      if (names === undefined) continue;
      for (const name of names) hidden.add(name);
    }
    if (hidden.size === 0) return cmd;
    return Command.annotate(cmd, LegacyHiddenFlags, hidden);
  };

export const withHiddenSubcommands =
  (names: ReadonlyArray<string>) =>
  <Name extends string, Input, ContextInput, E, R>(
    cmd: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> =>
    Command.annotate(cmd, LegacyHiddenSubcommands, new Set(names));

export const stripHiddenFlagsFromHelpDoc = (doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc => {
  const hiddenFlags = Context.get(doc.annotations, LegacyHiddenFlags);
  const hiddenSubcommands = Context.get(doc.annotations, LegacyHiddenSubcommands);
  if (hiddenFlags.size === 0 && hiddenSubcommands.size === 0) return doc;
  const filteredFlags = doc.flags.filter((flag) => !hiddenFlags.has(flag.name));
  const filteredGlobalFlags = doc.globalFlags?.filter((flag) => !hiddenFlags.has(flag.name));
  const filteredSubcommands = doc.subcommands?.flatMap((group) => {
    const commands = group.commands.filter((command) => !hiddenSubcommands.has(command.name));
    if (commands.length === 0) return [];
    return [
      {
        ...group,
        commands: commands as unknown as readonly [
          HelpDoc.SubcommandDoc,
          ...Array<HelpDoc.SubcommandDoc>,
        ],
      },
    ];
  });
  return {
    ...doc,
    flags: filteredFlags,
    ...(filteredSubcommands !== undefined && { subcommands: filteredSubcommands }),
    ...(filteredGlobalFlags !== undefined && { globalFlags: filteredGlobalFlags }),
  };
};
