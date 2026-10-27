import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, inject, test } from "vitest";
import { createHarness, type CLIResult } from "@supabase/cli-test-helpers";
import { type CliExecError, execCli, runE2e, testBehaviour } from "./test-context.ts";
import { ACCESS_TOKEN } from "./env.ts";

// A guaranteed-unreachable TCP address — connection is refused immediately.
// Used to simulate Docker being unavailable without relying on any external state.
const UNREACHABLE_DOCKER_HOST = "tcp://localhost:1";

// Minimal config.toml required by start/stop/status.
const setupStackWorkspace = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(dir, "supabase", "config.toml"),
    'project_id = "test-project"\n',
  );
});

// Extends testBehaviour with a `stackRun` fixture that automatically passes
// DOCKER_HOST to the CLI subprocess, pointing it at the relay server.
// In record mode the relay forwards Docker SDK calls to the real Docker socket;
// in replay mode it serves pre-recorded Docker API fixtures.
// The optional `dockerHost` override lets individual tests substitute an
// unreachable host to simulate Docker being unavailable.
interface StackFixtures {
  stackRun: (
    cmd: string[],
    opts?: { dockerHost?: string },
  ) => Effect.Effect<CLIResult, CliExecError>;
}

const testStack = testBehaviour.extend<StackFixtures>({
  stackRun: ({ runGuard, workspace }, use) => {
    const serverUrl = inject("replayServerUrl") as string;
    const dockerHostUrl = inject("dockerHostUrl") as string;
    const harness = createHarness({
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
    });
    return use((cmd, opts) =>
      runGuard.track(
        execCli(harness, cmd, { env: { DOCKER_HOST: opts?.dockerHost ?? dockerHostUrl } }),
      ),
    );
  },
});

const RequestLog = Schema.Array(Schema.Struct({ method: Schema.String, pathname: Schema.String }));

// `services` prints a static service matrix, so DOCKER_HOST is not needed.
describe("services", () => {
  testBehaviour("lists known service images", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["services"]);
        expect(result.exitCode).toBe(0);
        // Output is a pipe-separated markdown table; verify well-known image names appear.
        expect(result.stdout).toContain("postgres");
        expect(result.stdout).toContain("gotrue");
        expect(result.stdout).toContain("storage");
      }),
      signal,
    ),
  );
});

// `status` resolves and prints the current linked project/branch on stdout
// before any Docker/daemon work runs, in every output mode.
describe("status", () => {
  testStack("exits 1 when stack is not running", ({ workspace, stackRun, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStackWorkspace(workspace.path);
        const result = yield* stackRun(["status"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/no such container/i);
      }),
      signal,
    ),
  );
});

describe("stop", () => {
  testStack("succeeds when stack is not running", ({ workspace, stackRun, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStackWorkspace(workspace.path);
        const result = yield* stackRun(["stop"]);
        expect(result.exitCode).toBe(0);
      }),
      signal,
    ),
  );

  // Flag validation happens before the command runs, so no Docker or API calls are made.
  testStack(
    "exits 1 with mutual-exclusion error for --project-id and --all",
    ({ workspace, stackRun, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* setupStackWorkspace(workspace.path);
          const result = yield* stackRun(["stop", "--project-id", "test-project", "--all"]);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toMatch(/mutually exclusive|if any flags in the group.*are set/i);
        }),
        signal,
      ),
  );
});

describe("start", () => {
  testStack(
    "exits 1 with Docker error when Docker is unavailable",
    ({ workspace, stackRun, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* setupStackWorkspace(workspace.path);
          // Use an unreachable host so connection fails immediately without waiting
          // for a timeout. The relay has no special handling for this case.
          const result = yield* stackRun(["start"], { dockerHost: UNREACHABLE_DOCKER_HOST });
          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
        }),
        signal,
      ),
  );

  // Must run in sequence in a shared workspace so status/stop see the stack start brought up.
  // TODO: record once the full stack starts cleanly through the relay proxy (vector health check fails here).
  test.todo("start → status → stop lifecycle");
  test.todo("starts with --exclude studio and stops cleanly");
});

// `seed buckets` makes storage HTTP calls (not Docker), so plain testBehaviour
// with `run` is correct.
describe("seed buckets", () => {
  testBehaviour("creates buckets defined in config", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workspace.path, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspace.path, "supabase", "config.toml"),
          [
            'project_id = "test-project"',
            "",
            "[api]",
            // Point the local stack API at the relay server so bucket creation
            // calls are captured.
            `port = ${new URL(apiUrl).port}`,
            "",
            "[storage.buckets.my-bucket]",
            "public = false",
          ].join("\n"),
        );
        const result = yield* run(["seed", "buckets"]);
        expect(result.exitCode).toBe(0);
        const requests = yield* HttpClient.get(`${apiUrl}/_ctrl/requests`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RequestLog)),
        );
        expect(
          requests.some((r) => r.method === "POST" && r.pathname === "/storage/v1/bucket"),
        ).toBe(true);
      }),
      signal,
    ),
  );
});
