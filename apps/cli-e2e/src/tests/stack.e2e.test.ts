import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, test } from "vitest";
import { createHarness, exec, runParity, type CLIResult } from "@supabase/cli-test-helpers";
import { testBehaviour, testParity } from "./test-context.ts";
import { ACCESS_TOKEN, isRecording, TARGET } from "./env.ts";

// A guaranteed-unreachable TCP address — connection is refused immediately.
// Used to simulate Docker being unavailable without relying on any external state.
const UNREACHABLE_DOCKER_HOST = "tcp://localhost:1";

// Minimal config.toml required by start/stop/status.
function setupStackWorkspace(dir: string): void {
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(join(dir, "supabase", "config.toml"), 'project_id = "test-project"\n');
}

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
  stackRun: async ({ workspace }, use) => {
    const serverUrl = inject("replayServerUrl") as string;
    const dockerHostUrl = inject("dockerHostUrl") as string;
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
    });
    await use((cmd, opts) =>
      exec(harness, cmd, { env: { DOCKER_HOST: opts?.dockerHost ?? dockerHostUrl } }),
    );
  },
});

function testParityStack(cmd: string[], opts?: { workspaceSetup?: (dir: string) => void }): void {
  const label = `parity: ${cmd.join(" ")}`;
  test.skipIf(isRecording)(label, async () => {
    const serverUrl = inject("replayServerUrl") as string;
    const dockerHostUrl = inject("dockerHostUrl") as string;
    await runParity(
      {
        apiUrl: serverUrl,
        accessToken: ACCESS_TOKEN,
        workspaceSetup: opts?.workspaceSetup,
        extraEnv: { DOCKER_HOST: dockerHostUrl },
      },
      cmd,
    );
  });
}

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------
// `services` prints a baked-in Go-parity service matrix, so DOCKER_HOST is not
// needed.

describe("services", () => {
  testBehaviour("lists known service images", async ({ run }) => {
    const result = await run(["services"]);
    expect(result.exitCode).toBe(0);
    // Output is a pipe-separated markdown table; verify well-known image names appear.
    expect(result.stdout).toContain("postgres");
    expect(result.stdout).toContain("gotrue");
    expect(result.stdout).toContain("storage");
  });

  testParity(["services"]);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("status", () => {
  testStack("exits 1 when stack is not running", async ({ workspace, stackRun }) => {
    setupStackWorkspace(workspace.path);
    const result = await stackRun(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no such container/i);
  });

  testParityStack(["status"], { workspaceSetup: setupStackWorkspace });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  testStack("succeeds when stack is not running", async ({ workspace, stackRun }) => {
    setupStackWorkspace(workspace.path);
    const result = await stackRun(["stop"]);
    expect(result.exitCode).toBe(0);
  });

  // cobra's MarkFlagsMutuallyExclusive validates this before the command runs —
  // no Docker or API calls are made.
  testStack(
    "exits 1 with mutual-exclusion error for --project-id and --all",
    async ({ workspace, stackRun }) => {
      setupStackWorkspace(workspace.path);
      const result = await stackRun(["stop", "--project-id", "test-project", "--all"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/mutually exclusive|if any flags in the group.*are set/i);
    },
  );

  testParityStack(["stop"], { workspaceSetup: setupStackWorkspace });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("start", () => {
  testStack(
    "exits 1 with Docker error when Docker is unavailable",
    async ({ workspace, stackRun }) => {
      setupStackWorkspace(workspace.path);
      // Use an unreachable host so connection fails immediately without waiting
      // for a timeout. The relay has no special handling for this case.
      const result = await stackRun(["start"], { dockerHost: UNREACHABLE_DOCKER_HOST });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    },
  );

  // start → status → status --override-name → stop lifecycle test.
  // These must run in sequence in a single shared workspace so that status
  // and stop see the stack that start brought up.
  // TODO: record these in an environment where the full Supabase Docker stack starts
  // cleanly through the TCP relay proxy (vector health check fails on this machine).
  test.todo("start → status → stop lifecycle");
  test.todo("starts with --exclude studio and stops cleanly");

  test.todo("parity: start");
});

// ---------------------------------------------------------------------------
// seed buckets
// ---------------------------------------------------------------------------
// `seed buckets` makes storage HTTP calls (not Docker), so plain testBehaviour
// with `run` is correct.

describe("seed buckets", () => {
  testBehaviour("creates buckets defined in config", async ({ workspace, run, apiUrl }) => {
    mkdirSync(join(workspace.path, "supabase"), { recursive: true });
    writeFileSync(
      join(workspace.path, "supabase", "config.toml"),
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
    const result = await run(["seed", "buckets"]);
    expect(result.exitCode).toBe(0);
    const requests = await fetch(`${apiUrl}/_ctrl/requests`).then(
      (r) => r.json() as Promise<Array<{ method: string; pathname: string }>>,
    );
    expect(requests.some((r) => r.method === "POST" && r.pathname === "/storage/v1/bucket")).toBe(
      true,
    );
  });

  testParity(["seed", "buckets"], { workspaceSetup: setupStackWorkspace });
});
