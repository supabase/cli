import { randomUUID } from "node:crypto";
import type { ProvidedContext } from "vitest";
import {
  isAccessTokenProvided,
  isLive,
  KEEP_PROJECT,
  ORG_ID_OVERRIDE,
  PROJECT_HOST,
  TARGET,
  TARGET_API_URL,
} from "../src/tests/env.ts";
import {
  createStorageBucket,
  createTestProject,
  deleteTestProject,
  generateDbPassword,
  getAnonKey,
  getPoolerSessionUrl,
  getServiceRoleKey,
  resolveOrgId,
  waitForProjectReady,
} from "./staging-project.ts";
import "./provided-context.ts"; // centralized `inject()` key augmentation

const STORAGE_BUCKET = "cli-e2e-live-bucket";

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
  if (!isAccessTokenProvided) {
    throw new Error(
      "Live mode requires a staging access token: set SUPABASE_ACCESS_TOKEN " +
        "(or SUPABASE_E2E_CLI_LIVE_STAGING_ACCESS_TOKEN). Refusing to provision against an empty token.",
    );
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

  // Generated here (not a shared export) and routed through provide() so the
  // password reaches tests only via inject(), never an importable module const.
  const dbPassword = generateDbPassword();
  const projectRef = await createTestProject(TARGET_API_URL, orgId, name, dbPassword);

  // Once the project exists, any later setup failure must still delete it —
  // setup returns before the teardown closure, so Vitest cannot clean up.
  let anonKey: string;
  let functionsUrl: string;
  let dbUrl: string;
  try {
    await waitForProjectReady(TARGET_API_URL, projectRef);
    anonKey = await getAnonKey(TARGET_API_URL, projectRef);
    functionsUrl = `https://${projectRef}.${PROJECT_HOST}/functions/v1`;
    // IPv4 session-mode pooler — the direct host is IPv6-only (unreachable from
    // IPv4-only CI runners); the pooler is IPv4 and session mode supports pg_dump.
    dbUrl = await getPoolerSessionUrl(TARGET_API_URL, projectRef, dbPassword);
    // Seed a private bucket via the Storage API so the storage live tests have
    // something to cp/ls/rm against (cleaned up with the project on teardown).
    const serviceRoleKey = await getServiceRoleKey(TARGET_API_URL, projectRef);
    await createStorageBucket(PROJECT_HOST, projectRef, serviceRoleKey, STORAGE_BUCKET);
  } catch (err) {
    // Delete the half-provisioned project, but never mask the original failure.
    if (!KEEP_PROJECT) {
      await deleteTestProject(TARGET_API_URL, projectRef, { throwOnError: true }).catch(
        (cleanupErr) => console.error("Failed to delete project after setup failure:", cleanupErr),
      );
    }
    throw err;
  }

  provide("projectRef", projectRef);
  provide("anonKey", anonKey);
  provide("functionsUrl", functionsUrl);
  provide("dbUrl", dbUrl);
  provide("dbPassword", dbPassword);
  provide("storageBucket", STORAGE_BUCKET);

  return async () => {
    if (KEEP_PROJECT) {
      console.log(`CLI_E2E_KEEP_PROJECT set — leaving project ${projectRef} (${name}) alive`);
      return;
    }
    // Surface a failed teardown so a leaked staging project is visible locally
    // (CI also has the always() sweep as a backstop).
    await deleteTestProject(TARGET_API_URL, projectRef, { throwOnError: true });
  };
}
