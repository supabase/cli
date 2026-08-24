import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, inject, test } from "vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { createHarness, exec, type CLIResult } from "@supabase/cli-test-helpers";
import { testBehaviour } from "./test-context.ts";
import { ACCESS_TOKEN, TARGET } from "./env.ts";

// A guaranteed-unreachable TCP address — connection is refused immediately.
// Used to simulate Docker being unavailable without relying on any external state.
const UNREACHABLE_DOCKER_HOST = "tcp://localhost:1";
const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

// Minimal config.toml required by start/stop/status.
const setupStackWorkspace = (dir: string) =>
  Effect.gen(function* () {
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
  stackRun: (cmd: string[], opts?: { dockerHost?: string }) => Promise<CLIResult>;
}

const testStack = testBehaviour.extend<StackFixtures>({
  stackRun: ({ workspace }, use) => {
    const serverUrl = inject("replayServerUrl") as string;
    const dockerHostUrl = inject("dockerHostUrl") as string;
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
    });
    return Effect.runPromise(
      Effect.promise(() =>
        use((cmd, opts) =>
          exec(harness, cmd, { env: { DOCKER_HOST: opts?.dockerHost ?? dockerHostUrl } }),
        ),
      ),
    );
  },
});

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------
// `services` prints a baked-in Go-parity service matrix, so DOCKER_HOST is not
// needed.

describe("services", () => {
  testBehaviour("lists known service images", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["services"]));
        expect(result.exitCode).toBe(0);
        // Output is a pipe-separated markdown table; verify well-known image names appear.
        expect(result.stdout).toContain("postgres");
        expect(result.stdout).toContain("gotrue");
        expect(result.stdout).toContain("storage");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

// CLI-2167: `status` (ts-legacy only) resolves and prints the current linked
// project/branch on stdout, before any Docker/daemon work runs, in every
// output mode — an adjudicated, deliberate TS-only extension with no Go
// counterpart (Go's `status` never had a link-state concept).
describe("status", () => {
  testStack("exits 1 when stack is not running", ({ workspace, stackRun }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStackWorkspace(workspace.path);
        const result = yield* Effect.promise(() => stackRun(["status"]));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/no such container/i);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  testStack("succeeds when stack is not running", ({ workspace, stackRun }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStackWorkspace(workspace.path);
        const result = yield* Effect.promise(() => stackRun(["stop"]));
        expect(result.exitCode).toBe(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  // cobra's MarkFlagsMutuallyExclusive validates this before the command runs —
  // no Docker or API calls are made.
  testStack(
    "exits 1 with mutual-exclusion error for --project-id and --all",
    ({ workspace, stackRun }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* setupStackWorkspace(workspace.path);
          const result = yield* Effect.promise(() =>
            stackRun(["stop", "--project-id", "test-project", "--all"]),
          );
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toMatch(/mutually exclusive|if any flags in the group.*are set/i);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
  );
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("start", () => {
  testStack("exits 1 with Docker error when Docker is unavailable", ({ workspace, stackRun }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStackWorkspace(workspace.path);
        // Use an unreachable host so connection fails immediately without waiting
        // for a timeout. The relay has no special handling for this case.
        const result = yield* Effect.promise(() =>
          stackRun(["start"], { dockerHost: UNREACHABLE_DOCKER_HOST }),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  // start → status → status --override-name → stop lifecycle test.
  // These must run in sequence in a single shared workspace so that status
  // and stop see the stack that start brought up.
  // TODO: record these in an environment where the full Supabase Docker stack starts
  // cleanly through the TCP relay proxy (vector health check fails on this machine).
  test.todo("start → status → stop lifecycle");
  test.todo("starts with --exclude studio and stops cleanly");
});

// ---------------------------------------------------------------------------
// seed buckets
// ---------------------------------------------------------------------------
// `seed buckets` makes storage HTTP calls (not Docker), so plain testBehaviour
// with `run` is correct.

const RequestLogSchema = Schema.Array(
  Schema.Struct({ method: Schema.String, pathname: Schema.String }),
);

describe("seed buckets", () => {
  testBehaviour("creates buckets defined in config", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
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
        const result = yield* Effect.promise(() => run(["seed", "buckets"]));
        expect(result.exitCode).toBe(0);
        const response = yield* HttpClient.execute(
          HttpClientRequest.get(`${apiUrl}/_ctrl/requests`),
        );
        const body = yield* response.text;
        const requests = yield* Schema.decodeEffect(Schema.fromJsonString(RequestLogSchema))(body);
        expect(
          requests.some((r) => r.method === "POST" && r.pathname === "/storage/v1/bucket"),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});
