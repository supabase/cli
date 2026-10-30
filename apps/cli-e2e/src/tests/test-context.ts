import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Data, Effect, Formatter, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  type CLIHarness,
  type CLIResult,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN } from "./env.ts";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function scenarioSlug(task: { name: string; suite?: { name: string } | null }): string {
  const prefix = task.suite?.name ? slugify(task.suite.name) + "-" : "";
  return prefix + slugify(task.name);
}

type ExecOptions = NonNullable<Parameters<typeof exec>[2]>;

/** The CLI subprocess could not be spawned or awaited. */
export class CliExecError extends Data.TaggedError("CliExecError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The replay server refused to load the test's scenario. */
class ScenarioLoadError extends Data.Error<{ readonly message: string }> {}

/** CLI stdout did not decode as the expected JSON. */
class JsonOutputError extends Data.Error<{ readonly message: string }> {}

/** A test body passed without executing its CLI runner. */
class RunNotExecutedError extends Data.Error<{ readonly message: string }> {}

/** Runs the compiled CLI against a harness target. */
export const execCli = (harness: CLIHarness, cmd: string[], execOpts?: ExecOptions) =>
  Effect.tryPromise({
    try: () => exec(harness, cmd, execOpts),
    catch: (cause) =>
      new CliExecError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
  });

const sendControl = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(HttpClient.execute),
  );

/** POSTs a JSON body to a replay server control endpoint; a non-2xx answer fails. */
export const postControl = (url: string, body: unknown) =>
  sendControl(url, body).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));

const httpLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

const e2eLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, httpLayer);

/** Runs a test body at the Vitest edge with the file system, path, and HTTP services. */
export const runE2e = <A, E>(
  body: Effect.Effect<A, E, Layer.Success<typeof e2eLayer>>,
  signal?: AbortSignal,
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(e2eLayer)), { signal });

/** Decodes CLI stdout as JSON; a failure keeps the schema message plus a bounded stdout excerpt. */
export const decodeJsonOutput =
  <S extends Schema.Constraint>(schema: S) =>
  (stdout: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(stdout).pipe(
      Effect.mapError(
        (error) =>
          new JsonOutputError({
            message: `${error.message}\n  stdout: ${Formatter.format(stdout.slice(0, 200))}`,
          }),
      ),
    );

const ScenarioFailure = Schema.Struct({ message: Schema.String });

/** Marks a CLI run as executed for the current test. */
interface RunGuard {
  readonly track: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

interface BehaviourFixtures {
  runGuard: RunGuard;
  projectRef: string;
  orgId: string;
  workspace: TempDir;
  run: (cmd: string[], execOpts?: ExecOptions) => Effect.Effect<CLIResult, CliExecError>;
  runNoProjectId: (cmd: string[]) => Effect.Effect<CLIResult, CliExecError>;
  apiUrl: string;
  storageBucket: string;
  pgMockPort: number;
}

/** Custom test function for behavioural CLI tests.
 *
 *  Provides per-test:
 *  - `projectRef` — a real project ref (record mode) or the replay default
 *  - `orgId` — a real org slug (record mode) or the replay default
 *  - `workspace` — fresh temp dir, auto-disposed after the test
 *  - `run` — pre-configured `exec()` for the compiled CLI (optional second
 *    argument forwarded as `exec` options, e.g. extra `env` entries)
 *  - `apiUrl` — the replay server base URL (for setting up error overrides)
 *
 *  Auto-wires a named scenario for the test before running it, so the replay
 *  server knows which ordered interaction sequence to serve. Auto-clears the
 *  request log, error overrides, and active scenario after every test. */
export const testBehaviour = test.extend<BehaviourFixtures>({
  /* Fails a test that passed without executing a CLI run, e.g. because its body returned the
     Effect without `runE2e`. Checked once the test finished, after every fixture cleaned up. */
  runGuard: ({ task, onTestFinished }, use) => {
    let executed = false;
    onTestFinished(() => {
      if (!executed && task.result?.state === "pass") {
        return Effect.runPromise(
          new RunNotExecutedError({
            message: `"${task.name}" passed without executing its run Effect; return runE2e(Effect.gen(...), signal) from the test body`,
          }),
        );
      }
    });
    return use({
      track: (effect) =>
        Effect.suspend(() => {
          executed = true;
          return effect;
        }),
    });
  },

  projectRef: ({ task: _task }, use) => use(inject("projectRef")),

  orgId: ({ task: _task }, use) => use(inject("orgId")),

  workspace: ({ task }, use) => {
    const serverUrl = inject("replayServerUrl");
    const slug = scenarioSlug(task);
    return Effect.runPromise(
      Effect.gen(function* () {
        // Truncate to 40 chars to keep temp dir names manageable.
        const dir = yield* Effect.promise(() => makeTempDir(`cli-e2e-${slug.slice(0, 40)}-`));

        const res = yield* sendControl(`${serverUrl}/_ctrl/scenario`, { name: slug });
        if (res.status < 200 || res.status >= 300) {
          yield* Effect.promise(() => dir[Symbol.asyncDispose]());
          const { message } = yield* HttpClientResponse.schemaBodyJson(ScenarioFailure)(res);
          return yield* new ScenarioLoadError({ message });
        }

        yield* Effect.promise(() => use(dir));

        yield* Effect.promise(() => dir[Symbol.asyncDispose]());
        yield* Effect.all(
          [
            HttpClient.del(`${serverUrl}/_ctrl/requests`),
            HttpClient.del(`${serverUrl}/_ctrl/overrides`),
            HttpClient.del(`${serverUrl}/_ctrl/scenario`),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.provide(httpLayer)),
    );
  },

  run: ({ runGuard, workspace }, use) => {
    const serverUrl = inject("replayServerUrl");
    const harness = createHarness({
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
      projectId: inject("projectRef") as string,
    });
    return use((cmd, execOpts) => runGuard.track(execCli(harness, cmd, execOpts)));
  },

  runNoProjectId: ({ runGuard, workspace }, use) => {
    const serverUrl = inject("replayServerUrl");
    const harness = createHarness({
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
    });
    return use((cmd) => runGuard.track(execCli(harness, cmd)));
  },

  storageBucket: ({ task: _task }, use) => use(inject("storageBucket")),

  apiUrl: ({ task: _task }, use) => use(inject("replayServerUrl")),

  pgMockPort: ({ task: _task }, use) => use(inject("pgMockPort")),
});
