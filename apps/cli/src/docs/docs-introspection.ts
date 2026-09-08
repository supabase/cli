import type { Command, GlobalFlag, Param, Primitive } from "effect/unstable/cli";

/**
 * `.config.flags`/`.config.arguments` (a command's own declared params),
 * `.contextConfig.flags` (flags inherited via `Command.withSharedFlags`), and
 * `.globalFlags` (a command's own declared global flags) are genuinely absent
 * from the public `Command`/`Command.Any` TypeScript interface — only `name`,
 * `description`, `shortDescription`, `alias`, `examples`, `subcommands`,
 * `annotations`, and `hidden` are public — but they exist at runtime
 * (`internal/command.ts`'s `makeCommand`, via `Object.assign`; that internal
 * module is not importable — its package.json export map entry is `null` — so
 * there is no type-safe import to reach for instead).
 *
 * A bare `as unknown as` would silently paper over that gap (forbidden by
 * this repo's typing rules — see `CLAUDE.md`), so this narrows through a
 * runtime type guard instead, the same `"<field>" in value` shape
 * `param-introspection.ts`'s `isWrappedParam` establishes for
 * the identical problem. The guard checks the nested arrays consumers
 * actually dereference, so if a future `effect` version drops or reshapes
 * one of these fields, `commandInternals` throws a descriptive error
 * instead of silently completing against `undefined`.
 *
 * `cli/complete.ts` keeps its own private equivalents of these
 * guards — deliberately not hoisted, so the docs generator stays purely
 * additive over the existing tree.
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
 * A command's user-facing scoped global flag params — the flags commands
 * declare themselves. The parser's built-ins (`GlobalFlag.BuiltIns`) are only
 * injected at parse time and never stored on a command's `.globalFlags`, so
 * the reference omits them by construction (no filter needed — same fact that
 * let `complete.ts` drop its similar guard, issue #6482). Whether
 * the reference should document the built-ins that `--help` and completion
 * now show is a docs-surface decision tracked as a follow-up.
 */
export function userGlobalFlagParams(command: Command.Command.Any): ReadonlyArray<Param.AnyFlag> {
  return commandInternals(command).globalFlags.map((entry) => entry.flag);
}

/**
 * `Flag.choice`/`Flag.choiceWithValue`'s `choiceKeys` (the valid value set) is
 * attached to the `Choice`-tagged `Primitive<A>` via `Object.assign` at
 * runtime (`Primitive.choice`,
 * `.repos/effect/packages/effect/src/unstable/cli/Primitive.ts`) but carries
 * an `@internal` JSDoc tag and is absent from the public `Primitive<A>`
 * interface — the identical gap `CommandInternals` above works around
 * for `Command`, so this reuses the same runtime type-guard idiom instead of
 * an `as` cast.
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
