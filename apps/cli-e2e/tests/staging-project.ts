import { createHarness, exec } from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, REGION, TARGET } from "../src/tests/env.ts";

// Shared staging-project helpers used by both record setup (tests/setup.ts) and
// live setup (tests/live-setup.ts).
//
// `apiUrl` is whatever the CLI talks to: in record mode that is the replay
// server (so calls are captured); in live mode it is the real Management API
// (CLI_E2E_API_URL). The harness target + token come from env.

function harness(apiUrl: string) {
  return createHarness(TARGET, { apiUrl, accessToken: ACCESS_TOKEN });
}

const PROJECT_REF_RE = /^[a-z]{20}$/;

export async function resolveOrgId(apiUrl: string): Promise<string> {
  const result = await exec(harness(apiUrl), ["orgs", "list", "--output", "json"]);
  if (result.exitCode !== 0) throw new Error(`orgs list failed: ${result.stderr}`);
  const first = (JSON.parse(result.stdout) as Array<{ id: string }>)[0]?.id;
  if (!first) throw new Error("No orgs found — cannot create test project");
  return first;
}

export async function createTestProject(
  apiUrl: string,
  orgId: string,
  name: string,
): Promise<string> {
  const result = await exec(harness(apiUrl), [
    "projects",
    "create",
    name,
    "--org-id",
    orgId,
    "--db-password",
    "cli-e2e-password-123",
    "--region",
    REGION,
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) throw new Error(`projects create failed: ${result.stderr}`);
  const project = JSON.parse(result.stdout) as { id?: string; ref?: string };
  const ref = project.ref ?? project.id;
  if (!ref || !PROJECT_REF_RE.test(ref)) {
    throw new Error(`Unexpected project ref from create: ${result.stdout}`);
  }
  return ref;
}

export async function deleteTestProject(apiUrl: string, projectRef: string): Promise<void> {
  try {
    const result = await exec(harness(apiUrl), ["projects", "delete", projectRef, "--yes"]);
    if (result.exitCode !== 0) {
      console.error(`Warning: failed to delete test project ${projectRef}: ${result.stderr}`);
    }
  } catch (err) {
    console.error(`Warning: exception deleting test project ${projectRef}:`, err);
  }
}

export async function cleanupProjectsByName(apiUrl: string, names: string[]): Promise<void> {
  const listResult = await exec(harness(apiUrl), ["projects", "list", "--output", "json"]);
  if (listResult.exitCode !== 0) return;

  const projects = JSON.parse(listResult.stdout) as Array<{
    id: string;
    ref?: string;
    name: string;
  }>;

  for (const project of projects.filter((p) => names.includes(p.name))) {
    const ref = project.ref ?? project.id;
    if (ref && PROJECT_REF_RE.test(ref)) {
      await exec(harness(apiUrl), ["projects", "delete", ref, "--yes"]);
    }
  }
}

/** Poll the real Management API until the project is ACTIVE_HEALTHY. Hits the API
 *  directly (not via any proxy) — this is setup-only and must not be recorded. */
export async function waitForProjectReady(
  apiBaseUrl: string,
  projectRef: string,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiBaseUrl}/v1/projects/${projectRef}`, {
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

interface ApiKey {
  name?: string;
  api_key?: string;
}

/** Fetch the project's anon/publishable key for invoking deployed functions.
 *  Even after ACTIVE_HEALTHY the api-keys endpoint can briefly 4xx, so retry. */
export async function getPublishableKey(
  apiBaseUrl: string,
  projectRef: string,
  attempts = 12,
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(`${apiBaseUrl}/v1/projects/${projectRef}/api-keys`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (res.ok) {
      const keys = (await res.json()) as ApiKey[];
      // Prefer the new publishable key (sb_publishable_…); fall back to legacy anon.
      const publishable =
        keys.find((k) => k.api_key?.startsWith("sb_publishable_"))?.api_key ??
        keys.find((k) => k.name === "anon")?.api_key;
      if (publishable) return publishable;
    }
    if (attempt === attempts) {
      throw new Error(
        `Failed to resolve publishable/anon key for ${projectRef} after ${attempts} attempts: ${await res
          .text()
          .catch(() => res.status)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  // Unreachable — the loop either returns a key or throws on the last attempt.
  throw new Error(`Failed to resolve publishable/anon key for ${projectRef}`);
}
