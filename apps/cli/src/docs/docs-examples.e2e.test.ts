import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, Effect, Option } from "effect";

import { rootCommand } from "../cli/root.ts";
import { requireCliSuccess, runSupabaseEffect } from "../../tests/helpers/cli.ts";
import { walkCommandTree } from "../../tests/helpers/command-tree.ts";
import {
  isDocsExampleScenario,
  replayScenario,
} from "../../tests/helpers/docs-example-scenarios.ts";
import {
  comparableOutput,
  jsonOutputViolations,
  recordableOutput,
  requestsJsonOutput,
  rewriteRecordedResponse,
  substitute,
  supabaseInvocations,
} from "../../tests/helpers/docs-examples.ts";
import { readCommandDocs } from "./command-docs.ts";
import { docsJsonOutputSchema } from "./docs-spec.ts";

const recordedExamples = walkCommandTree(rootCommand).flatMap(({ path, command }) => {
  const docs = Option.getOrUndefined(readCommandDocs(command));
  return (docs?.examples ?? []).flatMap((example) =>
    example.output === "recorded" ? [{ path, example, jsonOutput: docs?.jsonOutput }] : [],
  );
});

/** `DOCS_EXAMPLES_UPDATE=1` rewrites drifted `response` text in source instead of failing. */
const updateMode = Config.Boolean("DOCS_EXAMPLES_UPDATE").pipe(Config.withDefault(false));

describe("recorded docs examples", () => {
  it("exist", () => {
    expect(recordedExamples.length).toBeGreaterThan(0);
  });

  for (const { path, example, jsonOutput } of recordedExamples) {
    it.live(`supabase ${path.join(" ")}: ${example.id} prints its recorded response`, () =>
      Effect.gen(function* () {
        if (!isDocsExampleScenario(example.scenario)) {
          return yield* Effect.die(`unknown docs example scenario "${example.scenario}"`);
        }
        const [argv, ...rest] = supabaseInvocations(example.code);
        if (argv === undefined || rest.length > 0) {
          return yield* Effect.die(`a recorded example runs one supabase command: ${example.code}`);
        }
        const run = yield* replayScenario(example.scenario);

        const result = yield* runSupabaseEffect([...argv], {
          cwd: run.cwd,
          home: run.home,
          env: run.env,
        });

        requireCliSuccess(result, example.code);
        if (jsonOutput !== undefined && requestsJsonOutput(argv)) {
          expect(
            jsonOutputViolations(docsJsonOutputSchema(jsonOutput), result.stdout),
            `stdout does not match the json_output_schema published from withDocs({ jsonOutput })`,
          ).toEqual([]);
        }
        const recorded = substitute(recordableOutput(result.stdout), run.substitutions);
        const drifted = comparableOutput(recorded) !== comparableOutput(example.response);
        if (drifted && (yield* updateMode)) {
          yield* rewriteRecordedResponse({
            commandPath: path,
            exampleId: example.id,
            response: recorded,
          });
          return;
        }
        expect(
          comparableOutput(recorded),
          `response drifted; re-record with DOCS_EXAMPLES_UPDATE=1 pnpm docs:examples\nstderr:\n${result.stderr}`,
        ).toBe(comparableOutput(example.response));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  }
});
