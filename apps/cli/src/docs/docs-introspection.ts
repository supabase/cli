import type { Command, GlobalFlag, Param, Primitive } from "effect/unstable/cli";

/**
 * `.config.flags`/`.contextConfig.flags`/`.globalFlags` exist on `Command` at runtime but are
 * absent from the public `Command`/`Command.Any` type, and the internal module that defines
 * them isn't importable. This narrows through a runtime type guard instead of an `as` cast
 * (same pattern as `param-introspection.ts`'s `isWrappedParam`), so a future `effect` shape
 * change throws a descriptive error here instead of silently reading `undefined`.
 */
export interface CommandInternals {
  readonly config: {
    readonly flags: ReadonlyArray<Param.AnyFlag>;
    readonly arguments: ReadonlyArray<Param.AnyArgument>;
  };
  readonly contextConfig: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly globalFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>;
}

function hasCommandInternals(
  command: Command.Command.Any,
): command is Command.Command.Any & CommandInternals {
  if (!("config" in command && "contextConfig" in command && "globalFlags" in command)) {
    return false;
  }
  const config: unknown = command.config;
  const contextConfig: unknown = command.contextConfig;
  const globalFlags: unknown = command.globalFlags;
  return (
    typeof config === "object" &&
    config !== null &&
    "flags" in config &&
    Array.isArray(config.flags) &&
    "arguments" in config &&
    Array.isArray(config.arguments) &&
    typeof contextConfig === "object" &&
    contextConfig !== null &&
    "flags" in contextConfig &&
    Array.isArray(contextConfig.flags) &&
    Array.isArray(globalFlags)
  );
}

export function commandInternals(command: Command.Command.Any): CommandInternals {
  if (!hasCommandInternals(command)) {
    throw new Error(
      `docs-introspection.ts: command "${command.name}" is missing the internal config/contextConfig/globalFlags fields tree introspection relies on — effect's Command implementation shape may have changed.`,
    );
  }
  return command;
}

/** A command's children, flattened across subcommand groups. */
export function flattenSubcommands(
  command: Command.Command.Any,
): ReadonlyArray<Command.Command.Any> {
  return command.subcommands.flatMap((group) => group.commands);
}

/**
 * A command's own declared global flag params. The parser's built-ins (`GlobalFlag.BuiltIns`)
 * are injected at parse time and never stored on `.globalFlags`, so they're excluded here by
 * construction.
 */
export function userGlobalFlagParams(command: Command.Command.Any): ReadonlyArray<Param.AnyFlag> {
  return commandInternals(command).globalFlags.map((entry) => entry.flag);
}

/**
 * `choiceKeys` (the valid value set for `Flag.Literals`/`Flag.ChoiceWithValue`) is attached to
 * the `Primitive<A>` at runtime but carries an `@internal` tag and is absent from the public
 * type, so this narrows through the same runtime type-guard idiom as `CommandInternals` above.
 */
interface ChoicePrimitive {
  readonly choiceKeys: ReadonlyArray<string>;
}

function hasChoiceKeys(
  primitive: Primitive.Primitive<unknown>,
): primitive is Primitive.Primitive<unknown> & ChoicePrimitive {
  return "choiceKeys" in primitive;
}

export function choiceKeysOf(
  primitive: Primitive.Primitive<unknown>,
): ReadonlyArray<string> | undefined {
  return hasChoiceKeys(primitive) ? primitive.choiceKeys : undefined;
}
