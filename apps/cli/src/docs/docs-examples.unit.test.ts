import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { CliError, CliOutput, Command } from "effect/cli";

import { rootCommand } from "../cli/root.ts";
import { walkCommandTree } from "../../tests/helpers/command-tree.ts";
import {
  isDocsExampleScenario,
  missingScenarioFixtures,
} from "../../tests/helpers/docs-example-scenarios.ts";
import { prepareCliArgs } from "../shared/cli/run.ts";
import { readCommandDocs } from "./command-docs.ts";
import { publishedDocsExamples, supabaseInvocations } from "../../tests/helpers/docs-examples.ts";

/** Examples that do not parse on purpose, keyed `"<command> <example id>"`. Every entry needs a reason. */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([]);

const silentFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

/*
 * The root's own handler is the one that dispatches to the selected subcommand, so replacing it
 * leaves `runWith` parsing the full argv (global flags, subcommand path, leaf flags, arguments and
 * validations) while no command handler or provided layer ever runs.
 */
const parseOnlyRoot = Command.withHandler(rootCommand, () => Effect.void);

const parseFailure = (argv: ReadonlyArray<string>) =>
  Command.runWith(parseOnlyRoot, { version: "0.0.0-docs-examples" })(
    prepareCliArgs(rootCommand, argv).args,
  ).pipe(
    Effect.as(undefined),
    Effect.catch((error) =>
      Effect.succeed(
        CliError.isCliError(error) && error._tag === "ShowHelp"
          ? error.errors.map((inner) => inner.message).join("; ")
          : String(error),
      ),
    ),
    Effect.provide(CliOutput.layer(silentFormatter)),
  );

describe("published docs examples", () => {
  it.effect("parse against the command tree", () =>
    Effect.gen(function* () {
      const examples = yield* publishedDocsExamples;
      const failures: Array<string> = [];
      const parsingAllowlisted: Array<string> = [];
      for (const { command, example } of examples) {
        const key = `${command} ${example.id}`;
        const invocations = supabaseInvocations(example.code ?? "");
        const errors =
          invocations.length === 0
            ? ["no `supabase` invocation in the example code"]
            : (yield* Effect.forEach(invocations, parseFailure)).filter(
                (error) => error !== undefined,
              );
        if (ALLOWLIST.has(key)) {
          if (errors.length === 0) parsingAllowlisted.push(key);
        } else {
          failures.push(...errors.map((error) => `${command}: ${example.id}: ${error}`));
        }
      }

      expect(examples.length).toBeGreaterThan(50);
      expect(failures, "docs examples that no longer parse").toEqual([]);
      expect(parsingAllowlisted, "ALLOWLIST entries that parse now; remove them").toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("recorded examples name a replay scenario that has a fixture", () =>
    Effect.gen(function* () {
      const slugs = walkCommandTree(rootCommand).flatMap(({ command }) =>
        (Option.getOrUndefined(readCommandDocs(command))?.examples ?? []).flatMap((example) =>
          example.output === "recorded" ? [example.scenario] : [],
        ),
      );
      expect(slugs.filter((slug) => !isDocsExampleScenario(slug))).toEqual([]);
      expect(yield* missingScenarioFixtures(slugs)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
