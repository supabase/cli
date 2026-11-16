import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/cli";

import {
  readSeedTargetFlags,
  seedTargetGlobalFlags,
} from "../../command-internal/target/target-flags.ts";
import { commandInternals } from "../../docs/docs-introspection.ts";
import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";

const REF = "abcdefghijklmnopqrst";

const silentFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

const parseProjectRef = (args: ReadonlyArray<string>) => {
  const seen: Array<Option.Option<string>> = [];
  const buckets = Command.make("buckets").pipe(
    Command.withHandler(() =>
      readSeedTargetFlags().pipe(Effect.map((flags) => seen.push(flags.projectRef))),
    ),
  );
  const seed = Command.make("seed").pipe(
    Command.withSubcommands([buckets]),
    Command.withGlobalFlags([
      seedTargetGlobalFlags.remote,
      seedTargetGlobalFlags.linked,
      seedTargetGlobalFlags.local,
      seedTargetGlobalFlags.projectRef,
    ]),
  );
  return Command.runWith(seed, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(silentFormatter))),
    Effect.map(() => seen[0]),
  );
};

describe("seed selector flags", () => {
  it("registers every selector flag on the group, so the leaf declares none of its own", () => {
    const leaf = commandTreeFor(undefined).get("seed buckets");
    expect(leaf).toBeDefined();
    if (leaf === undefined) return;
    expect(commandInternals(leaf.command).config.flags).toEqual([]);
    for (const flag of ["remote", "linked", "local", "project-ref"]) {
      expect(leaf.flags.has(flag), `--${flag}`).toBe(true);
    }
  });

  it.effect.each([
    { name: "before the subcommand", args: ["--project-ref", REF, "buckets"] },
    { name: "after the subcommand", args: ["buckets", "--project-ref", REF] },
  ])("reads --project-ref given $name", ({ args }) =>
    Effect.gen(function* () {
      expect(yield* parseProjectRef(args)).toEqual(Option.some(REF));
    }),
  );
});
