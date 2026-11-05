import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Layer, Path, type Scope } from "effect";

import { runSupabaseEffect } from "./cli.ts";
import {
  type DocsExampleKind,
  type DocsExampleRun,
  type DocsExampleScenarioError,
  DocsStack,
  dockerAvailable,
  FIXED_MIGRATION_VERSIONS,
  docsStackLayer,
  isDocsExampleScenario,
  prepareDocsExample,
  scenarioKind,
} from "./docs-example-scenarios.ts";
import {
  DOCS_EXAMPLE_GROUPS,
  type DocsExampleGroups,
  type DocsExampleSelector,
  groupSelects,
} from "./docs-example-groups.ts";
import {
  type AuthoredDocsExample,
  authoredDocsExamples,
  comparableOutput,
  jsonOutputViolations,
  recordableOutput,
  requestsJsonOutput,
  rewriteRecordedResponse,
  rewriteYamlResponse,
  substitute,
  supabaseInvocations,
} from "./docs-examples.ts";
import { docsJsonOutputSchema } from "../../src/docs/docs-spec.ts";

const recordedExamples = (
  await Effect.runPromise(authoredDocsExamples.pipe(Effect.provide(BunServices.layer)))
).filter((example) => example.output === "recorded");

const examplesOf = (kind: DocsExampleKind, group: string) => {
  const selector: DocsExampleSelector | undefined = Object.entries(DOCS_EXAMPLE_GROUPS[kind]).find(
    ([name]) => name === group,
  )?.[1];
  return recordedExamples.filter(
    (example) =>
      example.scenario !== undefined &&
      isDocsExampleScenario(example.scenario) &&
      scenarioKind(example.scenario) === kind &&
      selector !== undefined &&
      groupSelects(selector, example),
  );
};

/** `DOCS_EXAMPLES_UPDATE=1` rewrites drifted `response` text in source instead of failing. */
const updateMode = Config.Boolean("DOCS_EXAMPLES_UPDATE").pipe(Config.withDefault(false));

/** `DOCS_EXAMPLES_DOCKER=1` (`pnpm docs:examples:docker`) runs the examples that need a local stack. */
const dockerEnabled = await Effect.runPromise(
  Effect.gen(function* () {
    const requested = yield* Config.Boolean("DOCS_EXAMPLES_DOCKER").pipe(Config.withDefault(false));
    if (!requested) return false;
    if (!(yield* dockerAvailable)) {
      return yield* Effect.die("DOCS_EXAMPLES_DOCKER=1 is set but `docker info` failed");
    }
    return true;
  }).pipe(Effect.provide(BunServices.layer)),
);

const RUN_TIMEOUT_MS = 280_000;

const title = (example: AuthoredDocsExample) =>
  `supabase ${example.commandPath.join(" ")}: ${example.id} prints its recorded response`;

/** Runs `example` as `run` describes and checks or rewrites its recorded `response`. */
const checkRecorded = (
  example: AuthoredDocsExample,
  prepare: Effect.Effect<
    DocsExampleRun,
    DocsExampleScenarioError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const [argv, ...rest] = supabaseInvocations(example.code);
    if (argv === undefined || rest.length > 0) {
      return yield* Effect.die(`a recorded example runs one supabase command: ${example.code}`);
    }
    const run = yield* prepare;
    const result = yield* runSupabaseEffect(
      argv.map((word) => substitute(word, run.argv)),
      {
        cwd: run.cwd,
        home: run.home,
        env: run.env,
        mergeStderr: true,
        exitTimeoutMs: RUN_TIMEOUT_MS,
        ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
      },
    );
    yield* run.after;

    expect(result.exitCode, `${example.code} failed:\n${result.stdout}`).toBe(0);
    if (example.jsonOutput !== undefined && requestsJsonOutput(argv)) {
      expect(
        jsonOutputViolations(docsJsonOutputSchema(example.jsonOutput), result.stdout),
        `stdout does not match the json_output_schema published from withDocs({ jsonOutput })`,
      ).toEqual([]);
    }
    const recorded = substitute(recordableOutput(result.stdout), run.substitutions);
    const drifted =
      comparableOutput(recorded, FIXED_MIGRATION_VERSIONS) !==
      comparableOutput(example.response, FIXED_MIGRATION_VERSIONS);
    if (drifted && (yield* updateMode)) {
      yield* example.source === "withDocs"
        ? rewriteRecordedResponse({
            commandPath: example.commandPath,
            exampleId: example.id,
            response: recorded,
          })
        : rewriteYamlResponse({
            docId: ["supabase", ...example.commandPath].join("-"),
            exampleId: example.id,
            response: recorded,
          });
      return;
    }
    expect(
      comparableOutput(recorded, FIXED_MIGRATION_VERSIONS),
      `response drifted; re-record with DOCS_EXAMPLES_UPDATE=1 pnpm docs:examples`,
    ).toBe(comparableOutput(example.response, FIXED_MIGRATION_VERSIONS));
  });

const scenarioOf = (example: AuthoredDocsExample) => {
  const scenario = example.scenario;
  if (scenario === undefined || !isDocsExampleScenario(scenario)) {
    throw new Error(`unknown docs example scenario "${String(scenario)}"`);
  }
  return scenario;
};

const itLive = (example: AuthoredDocsExample) =>
  it.live(title(example), () =>
    checkRecorded(example, prepareDocsExample(scenarioOf(example))).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

/**
 * Registers the recorded docs examples of one group from `DOCS_EXAMPLE_GROUPS`. A docker group
 * starts its own stack, so its examples do not depend on another file having run.
 */
export const describeDocsExamples = <Kind extends DocsExampleKind>(options: {
  readonly kind: Kind;
  readonly group: DocsExampleGroups[Kind];
}) => {
  const examples = examplesOf(options.kind, String(options.group));
  const name = `recorded docs examples: ${options.kind} ${String(options.group)}`;

  if (options.kind !== "docker") {
    describe(name, () => {
      it("exist", () => {
        expect(examples.length).toBeGreaterThan(0);
      });
      for (const example of examples) itLive(example);
    });
    return;
  }
  if (dockerEnabled) {
    layer(Layer.provideMerge(docsStackLayer, BunServices.layer), {
      excludeTestServices: true,
      timeout: RUN_TIMEOUT_MS,
    })(`${name} (local Docker stack)`, (it) => {
      for (const example of examples) {
        it.effect(
          title(example),
          () =>
            Effect.gen(function* () {
              const stack = yield* DocsStack;
              yield* checkRecorded(example, stack.prepare(scenarioOf(example)));
            }).pipe(Effect.scoped),
          RUN_TIMEOUT_MS * 3,
        );
      }
    });
  } else {
    describe.skip(`${name} (pnpm docs:examples:docker)`, () => {
      for (const example of examples) it(title(example), () => {});
    });
  }
};
