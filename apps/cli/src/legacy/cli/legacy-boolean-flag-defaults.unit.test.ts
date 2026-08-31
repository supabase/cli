import { describe, expect, it } from "vitest";
import type { Command } from "effect/unstable/cli";
import {
  legacyCommandInternals,
  legacyFlattenSubcommands,
} from "../docs/legacy-docs-introspection.ts";
import { legacyUnwrapParam } from "../shared/legacy-param-introspection.ts";
import { legacyRoot } from "./root.ts";

/**
 * `Flag.boolean(name)` builds a bare `Single` param, and a bare `Single` is
 * *required* — omitting it fails the whole command with a missing-flag error
 * before the handler ever runs. Every boolean flag therefore has to be closed
 * off with `Flag.withDefault(false)` or `Flag.optional`.
 *
 * `workers push --wait` shipped without either and made a plain
 * `supabase experimental workers push` unusable. Nothing caught it: handler integration
 * tests build their flags record directly, so they never touch the parser, and
 * the required-ness is invisible to the type checker because a required boolean
 * flag still infers as `boolean`.
 */

function booleanFlagsRequiringAValue(command: Command.Command.Any): ReadonlyArray<string> {
  // Throws rather than skipping if effect's internal shape moves, so this
  // cannot quietly degrade into a test that inspects nothing.
  const own = legacyCommandInternals(command).config.flags.flatMap((flag) => {
    const unwrapped = legacyUnwrapParam(flag);
    if (unwrapped === undefined) {
      throw new Error(`Unrecognizable flag param on "${command.name}".`);
    }
    const { single, isOptional } = unwrapped;
    return single.primitiveType._tag === "Boolean" && !isOptional
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
