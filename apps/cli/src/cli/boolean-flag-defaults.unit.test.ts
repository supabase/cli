import { describe, expect, it } from "vitest";
import { Primitive, type Command } from "effect/unstable/cli";
import {
  commandInternals,
  flattenSubcommands,
  userGlobalFlagParams,
} from "../docs/docs-introspection.ts";
import { unwrapParam } from "../command-internal/param-introspection.ts";
import { rootCommandForFeatures } from "./root.ts";

/**
 * `Flag.boolean(name)` alone builds a required param, so omitting it fails the whole command
 * with a missing-flag error before the handler runs — every boolean flag must pair with
 * `Flag.withDefault(false)` or `Flag.optional`. No other test catches this: handler integration
 * tests build their flags record directly, bypassing the parser, and the type checker can't see
 * the required-ness since it still infers as `boolean`.
 */

/**
 * Uses `Primitive.getTypeName(Primitive.boolean)` rather than the literal `"boolean"`, so a
 * rename upstream breaks loudly instead of silently matching nothing and passing every command.
 * Avoids `primitiveType._tag` to keep this guard off effect's runtime representation.
 */
const BOOLEAN_TYPE_NAME = Primitive.getTypeName(Primitive.boolean);

function booleanFlagsRequiringAValue(command: Command.Command.Any): ReadonlyArray<string> {
  const internals = commandInternals(command);
  // Checks all three parameter sets a command can be parsed with, not just its own:
  // `Command.withSharedFlags` puts inherited flags on `contextConfig`, and the root's persistent
  // flags arrive as `globalFlags`.
  const params = [
    ...internals.config.flags,
    ...internals.contextConfig.flags,
    ...userGlobalFlagParams(command),
  ];

  // Throws rather than skipping if effect's internal shape moves, so this
  // cannot quietly degrade into a test that inspects nothing.
  const own = params.flatMap((flag) => {
    const unwrapped = unwrapParam(flag);
    if (unwrapped === undefined) {
      throw new Error(`Unrecognizable flag param on "${command.name}".`);
    }
    const { single, isOptional } = unwrapped;
    return Primitive.getTypeName(single.primitiveType) === BOOLEAN_TYPE_NAME && !isOptional
      ? [`${command.name} --${single.name}`]
      : [];
  });

  return [...own, ...flattenSubcommands(command).flatMap(booleanFlagsRequiringAValue)];
}

describe("boolean flag wiring", () => {
  it("gives every boolean flag a default, so omitting it is not a parse error", () => {
    for (const stackBackend of ["legacy", "stack"] as const) {
      for (const computeEnabled of [false, true]) {
        expect(
          booleanFlagsRequiringAValue(rootCommandForFeatures({ stackBackend, computeEnabled })),
        ).toEqual([]);
      }
    }
  });
});
