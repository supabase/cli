import type { ProvidedContext } from "vitest";
import { createHarness, exec } from "@supabase/cli-test-helpers";
import { startPgMock } from "../src/server/pg-mock.ts";
import { startReplayServer } from "../src/server/replay-server.ts";
import { ACCESS_TOKEN, isRecording, ORG_ID, PROJECT_REF, TARGET } from "../src/tests/env.ts";

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

declare module "vitest" {
  export interface ProvidedContext {
    replayServerUrl: string;
    projectRef: string;
    orgId: string;
    storageBucket: string;
    pgMockPort: number;
    /** DOCKER_HOST value (tcp://host:port) pointing at the relay server.
     *  In record mode the relay forwards to the real Docker socket; in replay
     *  mode it serves recorded Docker API fixtures. */
    dockerHostUrl: string;
  }
}

function resolveDockerSocket(): string {
  const dockerHost = process.env["DOCKER_HOST"];
  if (dockerHost?.startsWith("unix://")) return dockerHost.slice("unix://".length);
  return "/var/run/docker.sock";
}

function harness(serverUrl: string) {
  return createHarness(TARGET, { apiUrl: serverUrl, accessToken: ACCESS_TOKEN });
}

async function resolveOrgId(serverUrl: string): Promise<string> {
  const result = await exec(harness(serverUrl), ["orgs", "list", "--output", "json"]);
  if (result.exitCode !== 0) throw new Error(`orgs list failed: ${result.stderr}`);
  const first = (JSON.parse(result.stdout) as Array<{ id: string }>)[0]?.id;
  if (!first) throw new Error("No orgs found — cannot create test project");
  return first;
}

async function cleanupProjectsByName(serverUrl: string, names: string[]): Promise<void> {
  const listResult = await exec(harness(serverUrl), ["projects", "list", "--output", "json"]);
  if (listResult.exitCode !== 0) return;

  const projects = JSON.parse(listResult.stdout) as Array<{
    id: string;
    ref?: string;
    name: string;
  }>;

  for (const project of projects.filter((p) => names.includes(p.name))) {
    const ref = project.ref ?? project.id;
    if (ref && /^[a-z]{20}$/.test(ref)) {
      await exec(harness(serverUrl), ["projects", "delete", ref, "--yes"]);
    }
  }
}

async function waitForProjectReady(
  stagingApiUrl: string,
  projectRef: string,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${stagingApiUrl}/v1/projects/${projectRef}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (res.ok) {
      const project = (await res.json()) as { status?: string };
      if (project.status === "ACTIVE_HEALTHY") return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Project ${projectRef} did not become ACTIVE_HEALTHY within ${timeoutMs}ms`);
}

async function createTestProject(serverUrl: string, orgId: string): Promise<string> {
  const result = await exec(harness(serverUrl), [
    "projects",
    "create",
    "cli-e2e-test",
    "--org-id",
    orgId,
    "--db-password",
    "cli-e2e-password-123",
    "--region",
    "us-east-1",
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) throw new Error(`projects create failed: ${result.stderr}`);
  const project = JSON.parse(result.stdout) as { id?: string; ref?: string };
  const ref = project.ref ?? project.id;
  if (!ref || !/^[a-z]{20}$/.test(ref)) {
    throw new Error(`Unexpected project ref from create: ${result.stdout}`);
  }
  return ref;
}

async function deleteTestProject(serverUrl: string, projectRef: string): Promise<void> {
  try {
    const result = await exec(harness(serverUrl), ["projects", "delete", projectRef, "--yes"]);
    if (result.exitCode !== 0) {
      console.error(`Warning: failed to delete test project ${projectRef}: ${result.stderr}`);
    }
  } catch (err) {
    console.error(`Warning: exception deleting test project ${projectRef}:`, err);
  }
}

export async function setup({
  provide,
}: {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}) {
  const pgMock = startPgMock();
  provide("pgMockPort", pgMock.port);

  const server = await startReplayServer({ fixturesDir: FIXTURES_DIR, pgMock });
  provide("replayServerUrl", server.url);

  // Docker host URL: relay server in TCP form so DOCKER_HOST env can point at it.
  // In record mode the relay proxies to the real Docker socket; in replay mode it
  // serves recorded Docker API fixtures unchanged.
  const dockerHostUrl = server.url.replace(/^http:\/\//, "tcp://");
  provide("dockerHostUrl", dockerHostUrl);

  if (!isRecording) {
    // Replay mode — no real API calls; any valid 20-char string works as the
    // project ref because fixture paths normalize it to <PROJECT_REF>.
    provide("projectRef", PROJECT_REF);
    provide("orgId", ORG_ID);
    provide("storageBucket", "cli-e2e-bucket");
    return async () => {
      pgMock.stop();
      await server.stop();
    };
  }

  // Record mode — wire up Docker proxy so Docker SDK calls (via DOCKER_HOST) are
  // intercepted by the relay server and forwarded to the real Docker socket.
  server.setDockerProxyUrl(resolveDockerSocket());

  // Record mode — resolve org, then wipe any projects left over from previous
  // failed recording runs before creating a fresh dedicated test project.
  const orgId = await resolveOrgId(server.url);

  // Delete any orphaned projects whose names would conflict with what the tests
  // are about to create.  Runs before any scenario is loaded so these API calls
  // go straight to staging and are not captured in any scenario fixture.
  await cleanupProjectsByName(server.url, ["cli-e2e-test", "my-project", "to-delete"]);

  // Create a fresh project for this recording run.  Its ref is used by branches,
  // functions, secrets, and api-keys tests.
  const projectRef = await createTestProject(server.url, orgId);
  provide("projectRef", projectRef);
  provide("orgId", orgId);

  // Wire storage proxy so /storage/v1/ calls from --local mode reach staging.
  const stagingApiUrl = process.env["SUPABASE_STAGING_URL"]!;
  // Wait for the project to be fully initialised before fetching api-keys — the
  // api-keys endpoint is unavailable while the project is in COMING_SOON/BUILDING state.
  await waitForProjectReady(stagingApiUrl, projectRef);
  // Retry api-keys fetch: even after ACTIVE_HEALTHY, the endpoint may briefly return 4xx.
  let serviceRoleKey = "";
  for (let attempt = 1; attempt <= 12; attempt++) {
    const keysRes = await fetch(`${stagingApiUrl}/v1/projects/${projectRef}/api-keys`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (keysRes.ok) {
      const keys = (await keysRes.json()) as Array<{ name: string; api_key: string }>;
      serviceRoleKey = keys.find((k) => k.name === "service_role")?.api_key ?? "";
      break;
    }
    if (attempt === 12) {
      throw new Error(`Failed to fetch api-keys after 12 attempts: ${await keysRes.text()}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const storageBaseUrl = `https://${projectRef}.supabase.red`;
  server.setStorageProxyUrl(storageBaseUrl);
  server.setStorageProxyAuth(serviceRoleKey);

  // Create test bucket and seed a file — direct calls to staging, not via relay.
  await fetch(`${storageBaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: "cli-e2e-bucket", name: "cli-e2e-bucket", public: false }),
  });
  await fetch(`${storageBaseUrl}/storage/v1/object/cli-e2e-bucket/hello.txt`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "text/plain",
    },
    body: "hello world",
  });
  provide("storageBucket", "cli-e2e-bucket");

  return async () => {
    // The projects:delete test is self-contained (it creates and deletes its own
    // "to-delete" project).  The projects:create test creates "my-project" but
    // does not delete it, so we clean it up here.
    await cleanupProjectsByName(server.url, ["my-project"]);
    await deleteTestProject(server.url, projectRef);
    pgMock.stop();
    await server.stop();
  };
}
