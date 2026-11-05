import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CliError, CliOutput, Command } from "effect/cli";

import { rootCommand } from "../cli/root.ts";
import {
  isDocsExampleScenario,
  missingScenarioFixtures,
} from "../../tests/helpers/docs-example-scenarios.ts";
import {
  type AuthoredDocsExample,
  authoredDocsExamples,
} from "../../tests/helpers/docs-examples.ts";
import { prepareCliArgs } from "../shared/cli/run.ts";
import { publishedDocsExamples, supabaseInvocations } from "../../tests/helpers/docs-examples.ts";

/**
 * Examples whose `response` stays hand-written, keyed `"<command> <example id>"`, each with the
 * reason no harness run can produce it. The list only shrinks: a recorded or removed entry fails.
 */
const LINKED_DATABASE =
  "the linked project's database is reached at db.<ref>.<project host>:5432, which the harness cannot point at the local stack";

const ILLUSTRATIVE: ReadonlyMap<string, string> = new Map([
  ["supabase db diff linked-project", LINKED_DATABASE],
  ["supabase db dump linked-project", LINKED_DATABASE],
  ["supabase db dump role-only", LINKED_DATABASE],
  ["supabase db dump data-only", LINKED_DATABASE],
  ["supabase db pull basic-usage", LINKED_DATABASE],
  ["supabase db pull custom-schemas", LINKED_DATABASE],
  ["supabase db push basic-usage", LINKED_DATABASE],
  ["supabase db push dry-run", LINKED_DATABASE],
  ["supabase migration list basic-usage", LINKED_DATABASE],
  ["supabase migration repair basic-usage", LINKED_DATABASE],
  ["supabase migration repair mark-applied", LINKED_DATABASE],
  ["supabase login basic-usage", "the browser login flow waits for a person to approve it"],
  [
    "supabase sso add basic-usage",
    "the metadata URL is fetched over HTTPS from the identity provider before the API call",
  ],
]);

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

  it.effect("recorded examples name a known scenario whose replay fixture exists", () =>
    Effect.gen(function* () {
      const scenarios = (yield* authoredDocsExamples).flatMap((example) =>
        example.output === "recorded" ? [example.scenario ?? ""] : [],
      );
      const unknown = scenarios.filter((name) => !isDocsExampleScenario(name));
      expect(unknown, "recorded examples naming an unknown scenario").toEqual([]);
      expect(yield* missingScenarioFixtures(scenarios.filter(isDocsExampleScenario))).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("are recorded unless the illustrative allowlist names them", () =>
    Effect.gen(function* () {
      const keyOf = (example: AuthoredDocsExample) =>
        `supabase ${example.commandPath.join(" ")} ${example.id}`;
      const examples = yield* authoredDocsExamples;
      const illustrative = examples.filter((example) => example.output !== "recorded").map(keyOf);
      const recorded = new Set(
        examples.filter((example) => example.output === "recorded").map(keyOf),
      );
      expect(
        illustrative.filter((key) => !ILLUSTRATIVE.has(key)),
        "record these examples with a scenario (output: recorded) instead of hand-written responses",
      ).toEqual([]);
      expect(
        [...ILLUSTRATIVE.keys()].filter((key) => recorded.has(key) || !illustrative.includes(key)),
        "ILLUSTRATIVE entries that are recorded or gone; remove them",
      ).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
