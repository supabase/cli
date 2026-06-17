import { randomUUID } from "node:crypto";
import type { ProvidedContext } from "vitest";
import {
  isLive,
  KEEP_PROJECT,
  ORG_ID_OVERRIDE,
  PROJECT_HOST,
  TARGET,
  TARGET_API_URL,
} from "../src/tests/env.ts";
import {
  createTestProject,
  deleteTestProject,
  getAnonKey,
  resolveOrgId,
  TEST_DB_PASSWORD,
  waitForProjectReady,
} from "./staging-project.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** Publishable/anon key for invoking deployed functions over HTTP. */
    anonKey: string;
    /** https://{ref}.{CLI_E2E_PROJECT_HOST}/functions/v1 */
    functionsUrl: string;
    /** Direct Postgres connection string for --db-url DB commands. */
    dbUrl: string;
  }
}

// Live e2e global setup (ADR-0013). Provisions ONE ephemeral project per run,
// wired straight at the real Management API — no replay server. Intentionally
// dumb: no provisioning retry (the CI job re-runs the whole step on flake).
export async function setup({
  provide,
}: {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}) {
  if (!isLive) {
    // The live config was invoked without CLI_E2E_MODE=live. Every test is
    // skipIf(!isLive), so provision nothing.
    return () => {};
  }
  if (!PROJECT_HOST) {
    throw new Error("CLI_E2E_PROJECT_HOST is required in live mode (function invoke host)");
  }

  // Resolving the org via `orgs list` also exercises that command against the
  // real API; CLI_E2E_ORG_ID short-circuits it when set.
  const orgId = ORG_ID_OVERRIDE ?? (await resolveOrgId(TARGET_API_URL));

  // Per-job, per-run unique name so the CI cleanup can target only this job's
  // project (never a sibling matrix job's).
  const runId = process.env["GITHUB_RUN_ID"] ?? String(Date.now());
  const name = `cli-e2e-live-${TARGET}-${runId}-${randomUUID().slice(0, 8)}`;

  const projectRef = await createTestProject(TARGET_API_URL, orgId, name);

  // Once the project exists, any later setup failure must still delete it —
  // setup returns before the teardown closure, so Vitest cannot clean up.
  let anonKey: string;
  let functionsUrl: string;
  let dbUrl: string;
  try {
    await waitForProjectReady(TARGET_API_URL, projectRef);
    anonKey = await getAnonKey(TARGET_API_URL, projectRef);
    functionsUrl = `https://${projectRef}.${PROJECT_HOST}/functions/v1`;
    // Direct connection (db.<ref>.<host>:5432) — confirmed reachable; bypasses
    // the profile's project_host. connect_timeout keeps a bad attempt from hanging.
    dbUrl = `postgresql://postgres:${TEST_DB_PASSWORD}@db.${projectRef}.${PROJECT_HOST}:5432/postgres?connect_timeout=30`;
  } catch (err) {
    if (!KEEP_PROJECT) await deleteTestProject(TARGET_API_URL, projectRef);
    throw err;
  }

  provide("projectRef", projectRef);
  provide("anonKey", anonKey);
  provide("functionsUrl", functionsUrl);
  provide("dbUrl", dbUrl);

  return async () => {
    if (KEEP_PROJECT) {
      console.log(`CLI_E2E_KEEP_PROJECT set — leaving project ${projectRef} (${name}) alive`);
      return;
    }
    await deleteTestProject(TARGET_API_URL, projectRef);
  };
}
