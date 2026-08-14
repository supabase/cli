import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param, Primitive } from "effect/unstable/cli";

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
 * `legacy-param-introspection.ts`'s `legacyIsWrappedParam` establishes for
 * the identical problem. The guard checks the nested arrays consumers
 * actually dereference, so if a future `effect` version drops or reshapes
 * one of these fields, `legacyCommandInternals` throws a descriptive error
 * instead of silently completing against `undefined`.
 *
 * `legacy/cli/legacy-complete.ts` keeps its own private equivalents of these
 * guards — deliberately not hoisted, so the docs generator stays purely
 * additive over the existing tree.
 */
export interface LegacyCommandInternals {
  readonly config: {
    readonly flags: ReadonlyArray<Param.AnyFlag>;
    readonly arguments: ReadonlyArray<Param.AnyArgument>;
  };
  readonly contextConfig: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly globalFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>;
}

function legacyHasCommandInternals(
  command: Command.Command.Any,
): command is Command.Command.Any & LegacyCommandInternals {
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

export function legacyCommandInternals(command: Command.Command.Any): LegacyCommandInternals {
  if (!legacyHasCommandInternals(command)) {
    throw new Error(
      `legacy-docs-introspection.ts: command "${command.name}" is missing the internal config/contextConfig/globalFlags fields tree introspection relies on — effect's Command implementation shape may have changed.`,
    );
  }
  return command;
}

/** A command's children, flattened across subcommand groups. */
export function legacyFlattenSubcommands(
  command: Command.Command.Any,
): ReadonlyArray<Command.Command.Any> {
  return command.subcommands.flatMap((group) => group.commands);
}

/**
 * A command's user-facing scoped global flag params. `GlobalFlag.Completions`
 * and `GlobalFlag.LogLevel` are TS-only framework additions with no Go/cobra
 * equivalent; they are normally only injected via `GlobalFlag.BuiltIns` at
 * parse time (never stored on a command's own `.globalFlags`), so the filter
 * is a defensive guard rather than something that changes today's output —
 * kept explicit so it stays true if that ever changes.
 */
export function legacyUserGlobalFlagParams(
  command: Command.Command.Any,
): ReadonlyArray<Param.AnyFlag> {
  return legacyCommandInternals(command)
    .globalFlags.filter(
      (entry) => entry !== GlobalFlag.Completions && entry !== GlobalFlag.LogLevel,
    )
    .map((entry) => entry.flag);
}

/**
 * `Flag.choice`/`Flag.choiceWithValue`'s `choiceKeys` (the valid value set) is
 * attached to the `Choice`-tagged `Primitive<A>` via `Object.assign` at
 * runtime (`Primitive.choice`,
 * `.repos/effect/packages/effect/src/unstable/cli/Primitive.ts`) but carries
 * an `@internal` JSDoc tag and is absent from the public `Primitive<A>`
 * interface — the identical gap `LegacyCommandInternals` above works around
 * for `Command`, so this reuses the same runtime type-guard idiom instead of
 * an `as` cast.
 */
interface LegacyChoicePrimitive {
  readonly choiceKeys: ReadonlyArray<string>;
}

function legacyHasChoiceKeys(
  primitive: Primitive.Primitive<unknown>,
): primitive is Primitive.Primitive<unknown> & LegacyChoicePrimitive {
  return "choiceKeys" in primitive;
}

export function legacyChoiceKeysOf(
  primitive: Primitive.Primitive<unknown>,
): ReadonlyArray<string> | undefined {
  return legacyHasChoiceKeys(primitive) ? primitive.choiceKeys : undefined;
}
