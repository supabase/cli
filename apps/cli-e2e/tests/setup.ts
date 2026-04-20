import type { ProvidedContext } from "vitest";
import { createHarness, exec } from "@supabase/cli-test-helpers";
import { startReplayServer } from "../src/server/replay-server.ts";
import { ACCESS_TOKEN, isRecording, ORG_ID, PROJECT_REF, TARGET } from "../src/tests/env.ts";

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

declare module "vitest" {
  export interface ProvidedContext {
    replayServerUrl: string;
    projectRef: string;
    orgId: string;
  }
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
  const server = await startReplayServer({ fixturesDir: FIXTURES_DIR });
  provide("replayServerUrl", server.url);

  if (!isRecording) {
    // Replay mode — no real API calls; any valid 20-char string works as the
    // project ref because fixture paths normalize it to <PROJECT_REF>.
    provide("projectRef", PROJECT_REF);
    provide("orgId", ORG_ID);
    return async () => {
      await server.stop();
    };
  }

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

  return async () => {
    // The projects:delete test is self-contained (it creates and deletes its own
    // "to-delete" project).  The projects:create test creates "my-project" but
    // does not delete it, so we clean it up here.
    await cleanupProjectsByName(server.url, ["my-project"]);
    await deleteTestProject(server.url, projectRef);
    await server.stop();
  };
}
