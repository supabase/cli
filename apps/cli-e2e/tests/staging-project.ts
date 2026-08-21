import { randomBytes } from "node:crypto";
import { createHarness, exec } from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, REGION, TARGET } from "../src/tests/env.ts";

// Shared staging-project helpers used by record setup (tests/setup.ts).
// `apiUrl` is the replay server URL, which proxies calls to staging while
// recording. The harness target + token come from env.

function harness(apiUrl: string) {
  return createHarness(TARGET, { apiUrl, accessToken: ACCESS_TOKEN });
}

const PROJECT_REF_RE = /^[a-z]{20}$/;
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);

/** A DB password for a throwaway recording project. Randomised per call
 *  (overridable via CLI_E2E_DB_PASSWORD) so no static credential is committed —
 *  the project is deleted on teardown anyway. */
export function generateDbPassword(): string {
  return process.env["CLI_E2E_DB_PASSWORD"] ?? `cli-e2e-${randomBytes(12).toString("hex")}`;
}

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
  password: string,
): Promise<string> {
  const result = await exec(harness(apiUrl), [
    "projects",
    "create",
    name,
    "--org-id",
    orgId,
    "--db-password",
    password,
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

// `throwOnError` surfaces deletion failures when a caller needs to fail loudly;
// record setup keeps the lenient default.
export async function deleteTestProject(
  apiUrl: string,
  projectRef: string,
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  try {
    const result = await exec(harness(apiUrl), ["projects", "delete", projectRef, "--yes"]);
    if (result.exitCode !== 0) {
      throw new Error(`projects delete exited ${result.exitCode}: ${result.stderr}`);
    }
  } catch (err) {
    if (opts.throwOnError) throw err;
    console.error(`Warning: failed to delete test project ${projectRef}:`, err);
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

/** Poll the Management API until the recording project is ACTIVE_HEALTHY. */
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
      if (project.status && TERMINAL_BAD_STATUSES.has(project.status)) {
        throw new Error(
          `Project ${projectRef} entered terminal status ${project.status} during provisioning`,
        );
      }
    } else {
      await res.body?.cancel();
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Project ${projectRef} did not become ACTIVE_HEALTHY within ${timeoutMs}ms`);
}
