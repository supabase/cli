import { Data, Effect, FileSystem, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";

import { startReplayServer } from "../../../cli-e2e/src/server/replay-server.ts";
import { resetReplay } from "../../scripts/replay-control.ts";
import { makeTempHome } from "./cli.ts";

/** Where and how a recorded docs example runs, and the run-specific text its output must not keep. */
export interface DocsExampleRun {
  readonly cwd: string;
  readonly home: string;
  readonly env: Record<string, string>;
  /** `[from, to]` replacements applied to the output before it is compared or recorded. */
  readonly substitutions: ReadonlyArray<readonly [string, string]>;
}

export class DocsExampleScenarioError extends Data.TaggedError("DocsExampleScenarioError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const ACCESS_TOKEN = `sbp_${"0".repeat(40)}`;

/** The project `docs-projects-list` marks as linked; the replay fixture's first project. */
const DOCS_LINKED_PROJECT_REF = "xkvpqmdrbtwnjzhcuaoe";

const FIXTURES_DIR = new URL("../../../cli-e2e/fixtures", import.meta.url).pathname;

/** The replay scenarios (`apps/cli-e2e/fixtures/scenarios/<slug>`) a `recorded` docs example can name. */
export const DOCS_EXAMPLE_SCENARIOS = ["docs-projects-list"] as const;

export type DocsExampleScenario = (typeof DOCS_EXAMPLE_SCENARIOS)[number];

export const isDocsExampleScenario = (slug: string): slug is DocsExampleScenario =>
  DOCS_EXAMPLE_SCENARIOS.some((known) => known === slug);

/** Slugs without a recorded `interactions.json`, which the replay server would reject at start. */
export const missingScenarioFixtures = Effect.fn("docsExamples.missingScenarioFixtures")(function* (
  slugs: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const missing: Array<string> = [];
  for (const slug of slugs) {
    if (!(yield* fs.exists(`${FIXTURES_DIR}/scenarios/${slug}/interactions.json`))) {
      missing.push(slug);
    }
  }
  return missing;
});

/**
 * Runs the CLI against the replay server with `slug` loaded, as a logged-in user linked to the
 * replay project, from an empty temp home.
 */
export const replayScenario = (
  slug: DocsExampleScenario,
): Effect.Effect<DocsExampleRun, DocsExampleScenarioError, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const server = yield* startReplayServer({
      fixturesDir: FIXTURES_DIR,
      record: false,
      stagingUrl: undefined,
    });
    yield* resetReplay(server.url, slug).pipe(Effect.provide(FetchHttpClient.layer));
    const home = yield* makeTempHome;
    const profile = `${home.dir}/docs-example-profile.yaml`;
    yield* fs.writeFileString(
      profile,
      [
        "name: docs-example",
        `api_url: "${server.url}"`,
        `dashboard_url: "${server.url}"`,
        "project_host: localhost",
        "",
      ].join("\n"),
    );
    const realHome = yield* fs.realPath(home.dir);
    const run: DocsExampleRun = {
      cwd: home.dir,
      home: home.dir,
      env: {
        SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN,
        SUPABASE_PROFILE: profile,
        SUPABASE_PROJECT_ID: DOCS_LINKED_PROJECT_REF,
      },
      substitutions: [
        [server.url, "https://api.supabase.com"],
        [realHome, "~/.supabase"],
        [home.dir, "~/.supabase"],
      ],
    };
    return run;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DocsExampleScenarioError({ message: `replay scenario "${slug}" failed`, cause }),
    ),
  );
