import { inject, test } from "vitest";
import { Data, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  createHarness,
  exec,
  makeTempDir,
  type CLIResult,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, TARGET } from "./env.ts";

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

class ReplayControlError extends Data.TaggedError("ReplayControlError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function toControlError(cause: unknown): ReplayControlError {
  return new ReplayControlError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function controlRequest(
  serverUrl: string,
  path: string,
  method: "DELETE" | "POST",
  body?: unknown,
): Effect.Effect<void, ReplayControlError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const request =
      body === undefined
        ? HttpClientRequest.make(method)(`${serverUrl}${path}`)
        : yield* HttpClientRequest.make(method)(`${serverUrl}${path}`).pipe(
            HttpClientRequest.bodyJson(body),
          );
    const response = yield* HttpClient.execute(request);
    if (response.status >= 200 && response.status < 300) return;
    const payload = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    const messageValue =
      typeof payload === "object" && payload !== null && "message" in payload
        ? payload.message
        : undefined;
    const message =
      typeof messageValue === "string"
        ? messageValue
        : `Replay control request failed (${response.status})`;
    return yield* new ReplayControlError({ message });
  }).pipe(Effect.mapError(toControlError));
}

type ExecOptions = NonNullable<Parameters<typeof exec>[2]>;

interface BehaviourFixtures {
  projectRef: string;
  orgId: string;
  workspace: TempDir;
  run: (cmd: string[], execOpts?: ExecOptions) => Promise<CLIResult>;
  runNoProjectId: (cmd: string[]) => Promise<CLIResult>;
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
 *  - `run` — pre-configured `exec()` for the current TARGET (optional second
 *    argument forwarded as `exec` options, e.g. extra `env` entries)
 *  - `apiUrl` — the replay server base URL (for setting up error overrides)
 *
 *  Auto-wires a named scenario for the test before running it, so the replay
 *  server knows which ordered interaction sequence to serve. Auto-clears the
 *  request log, error overrides, and active scenario after every test. */
export const testBehaviour = test.extend<BehaviourFixtures>({
  projectRef: ({ task: _task }, use) => {
    return use(inject("projectRef") as string);
  },

  orgId: ({ task: _task }, use) => {
    return use(inject("orgId") as string);
  },

  workspace: ({ task }, use) => {
    const serverUrl = inject("replayServerUrl");
    const slug = scenarioSlug(task);
    // Truncate to 40 chars to keep temp dir names manageable.
    return Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => makeTempDir(`cli-e2e-${slug.slice(0, 40)}-`),
          catch: toControlError,
        }),
        (dir) =>
          Effect.gen(function* () {
            yield* controlRequest(serverUrl, "/_ctrl/scenario", "POST", { name: slug });
            yield* Effect.tryPromise({ try: () => use(dir), catch: toControlError });
          }),
        (dir) =>
          Effect.gen(function* () {
            yield* controlRequest(serverUrl, "/_ctrl/requests", "DELETE");
            yield* controlRequest(serverUrl, "/_ctrl/overrides", "DELETE");
            yield* controlRequest(serverUrl, "/_ctrl/scenario", "DELETE");
            yield* Effect.tryPromise({
              try: () => dir[Symbol.asyncDispose](),
              catch: toControlError,
            });
          }),
      ).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
    );
  },

  run: ({ workspace }, use) => {
    const serverUrl = inject("replayServerUrl");
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
      projectId: inject("projectRef") as string,
    });
    return use((cmd, execOpts) => exec(harness, cmd, execOpts));
  },

  runNoProjectId: ({ workspace }, use) => {
    const serverUrl = inject("replayServerUrl");
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
    });
    return use((cmd) => exec(harness, cmd));
  },

  storageBucket: ({ task: _task }, use) => {
    return use(inject("storageBucket") as string);
  },

  apiUrl: ({ task: _task }, use) => {
    return use(inject("replayServerUrl"));
  },

  pgMockPort: ({ task: _task }, use) => {
    return use(inject("pgMockPort") as number);
  },
});
