import { describe, expect, it } from "vitest";
import { Primitive, type Command } from "effect/unstable/cli";
import {
  legacyCommandInternals,
  legacyFlattenSubcommands,
  legacyUserGlobalFlagParams,
} from "../docs/legacy-docs-introspection.ts";
import { legacyUnwrapParam } from "../shared/legacy-param-introspection.ts";
import { legacyRoot } from "./root.ts";

/**
 * `Flag.boolean(name)` builds a bare `Single` param, and a bare `Single` is
 * *required* — omitting it fails the whole command with a missing-flag error
 * before the handler ever runs. Every boolean flag therefore has to be closed
 * off with `Flag.withDefault(false)` or `Flag.optional`.
 *
 * Nothing else catches this: handler integration tests build their flags record
 * directly, so they never touch the parser, and the required-ness is invisible
 * to the type checker because a required boolean flag still infers as
 * `boolean`. The flag only misbehaves when a real invocation omits it, which is
 * precisely the invocation no handler test makes — so the guard walks the
 * command tree instead of waiting for a command to be exercised end to end.
 *
 * `experimental workers push --wait` is the flag that prompted it: it first
 * shipped with neither closer, which made a plain
 * `supabase experimental workers push` fail to parse at all.
 */

/**
 * The published getter for a primitive's kind — `Primitive.getTypeName`, whose
 * own doc example pins `Primitive.boolean` to `"boolean"`. Reading
 * `primitiveType._tag` instead would couple this guard to effect's runtime
 * representation, which this repo forbids in tests as well as in source.
 *
 * Derived from `Primitive.boolean` rather than written as the literal
 * `"boolean"`: were that name to change upstream, a hardcoded literal would
 * match nothing and leave the guard silently passing every command, which is
 * the one failure mode a regression test must not have.
 */
const BOOLEAN_TYPE_NAME = Primitive.getTypeName(Primitive.boolean);

function booleanFlagsRequiringAValue(command: Command.Command.Any): ReadonlyArray<string> {
  const internals = legacyCommandInternals(command);
  // All three parameter sets a command can be parsed with, not just its own:
  // `Command.withSharedFlags` puts inherited flags on `contextConfig`, and the
  // root's persistent flags arrive as `globalFlags`. A bare boolean introduced
  // through either would break every command that inherits it while a guard
  // reading only `config.flags` stayed green.
  const params = [
    ...internals.config.flags,
    ...internals.contextConfig.flags,
    ...legacyUserGlobalFlagParams(command),
  ];

  // Throws rather than skipping if effect's internal shape moves, so this
  // cannot quietly degrade into a test that inspects nothing.
  const own = params.flatMap((flag) => {
    const unwrapped = legacyUnwrapParam(flag);
    if (unwrapped === undefined) {
      throw new Error(`Unrecognizable flag param on "${command.name}".`);
    }
    const { single, isOptional } = unwrapped;
    return Primitive.getTypeName(single.primitiveType) === BOOLEAN_TYPE_NAME && !isOptional
      ? [`${command.name} --${single.name}`]
      : [];
  });

  return [...own, ...legacyFlattenSubcommands(command).flatMap(booleanFlagsRequiringAValue)];
}

describe("legacy boolean flag wiring", () => {
  it("gives every boolean flag a default, so omitting it is not a parse error", () => {
    expect(booleanFlagsRequiringAValue(legacyRoot)).toEqual([]);
  });
});
