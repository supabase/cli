import { randomBytes, randomUUID } from "node:crypto";

import { runSupabase } from "./cli.ts";
import { keepLiveProject, liveApiBaseUrl, liveProfile, liveProjectHost } from "./live-env.ts";

const PROJECT_REF_RE = /^[a-z]{20}$/u;
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);
const DEFAULT_STORAGE_BUCKET = "supabase-cli-live-bucket";

export interface LiveProjectEnvironment {
  readonly projectRef: string;
  readonly anonKey: string;
  readonly functionsUrl: string;
  readonly dbUrl: string;
  readonly dbPassword: string;
  readonly storageBucket: string;
  readonly projectName: string;
  readonly owned: true;
}

function accessToken(): string {
  const token = process.env["SUPABASE_ACCESS_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new Error(
      "Managed live mode requires SUPABASE_ACCESS_TOKEN; refusing to provision with an empty token.",
    );
  }
  return token;
}

function apiBaseUrl(): string {
  return liveApiBaseUrl().replace(/\/+$/u, "");
}

function cliEnv(): Record<string, string> {
  return { SUPABASE_PROFILE: liveProfile() };
}

async function managementCommand(args: string[]) {
  return runSupabase(args, {
    entrypoint: "legacy",
    env: cliEnv(),
    exitTimeoutMs: 240_000,
  });
}

function jsonError(
  result: { exitCode: number; stderr: string; stdout: string },
  command: string,
): Error {
  return new Error(
    `${command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
  );
}

async function resolveOrgId(): Promise<string> {
  const override = process.env["SUPABASE_LIVE_ORG_ID"];
  if (override !== undefined && override.length > 0) return override;

  const result = await managementCommand(["orgs", "list", "--output", "json"]);
  if (result.exitCode !== 0) throw jsonError(result, "orgs list");
  const rows = JSON.parse(result.stdout) as Array<{ id?: string }>;
  const id = rows[0]?.id;
  if (id === undefined || id.length === 0) {
    throw new Error("No organizations found; cannot create the managed live project");
  }
  return id;
}

function generateDbPassword(): string {
  return (
    process.env["SUPABASE_LIVE_DB_PASSWORD"] ??
    `supabase-cli-live-${randomBytes(12).toString("hex")}`
  );
}

async function createProject(name: string, orgId: string, dbPassword: string): Promise<string> {
  const region = process.env["SUPABASE_LIVE_REGION"] ?? "us-east-1";
  const result = await managementCommand([
    "projects",
    "create",
    name,
    "--org-id",
    orgId,
    "--db-password",
    dbPassword,
    "--region",
    region,
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) throw jsonError(result, "projects create");

  const project = JSON.parse(result.stdout) as { id?: string; ref?: string };
  const ref = project.ref ?? project.id;
  if (ref === undefined || !PROJECT_REF_RE.test(ref)) {
    throw new Error(`Unexpected project ref from projects create: ${result.stdout}`);
  }
  return ref;
}

async function deleteProject(projectRef: string): Promise<void> {
  const result = await managementCommand(["projects", "delete", projectRef, "--yes"]);
  if (result.exitCode !== 0) throw jsonError(result, `projects delete ${projectRef}`);
}

async function waitForProjectReady(projectRef: string, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${apiBaseUrl()}/v1/projects/${projectRef}`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    if (response.ok) {
      const project = (await response.json()) as { status?: string };
      if (project.status === "ACTIVE_HEALTHY") return;
      if (project.status !== undefined && TERMINAL_BAD_STATUSES.has(project.status)) {
        throw new Error(
          `Project ${projectRef} entered terminal status ${project.status} during provisioning`,
        );
      }
    } else {
      await response.body?.cancel();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(5_000, remaining)));
  }
  throw new Error(`Project ${projectRef} did not become ACTIVE_HEALTHY within ${timeoutMs}ms`);
}

interface ApiKey {
  readonly name?: string;
  readonly api_key?: string;
}

/**
 * API keys are eventually consistent after project readiness. Polling is an
 * intrinsic part of provisioning because the Management API exposes no
 * readiness event; bound it by wall-clock time rather than attempt count.
 */
async function getProjectKeys(projectRef: string, timeoutMs = 180_000): Promise<ApiKey[]> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const response = await fetch(`${apiBaseUrl()}/v1/projects/${projectRef}/api-keys`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    lastStatus = String(response.status);
    if (response.ok) {
      const keys = (await response.json()) as ApiKey[];
      if (keys.length > 0) return keys;
    } else {
      await response.body?.cancel();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10_000, remaining)));
  }
  throw new Error(
    `Failed to resolve API keys for ${projectRef} within ${timeoutMs}ms (${lastStatus})`,
  );
}

async function getAnonKey(projectRef: string): Promise<string> {
  const keys = await getProjectKeys(projectRef);
  const anon = keys.find((key) => key.name === "anon" && key.api_key)?.api_key;
  if (anon !== undefined) return anon;
  throw new Error(`Project ${projectRef} returned no legacy anon JWT for function invokes`);
}

async function getServiceRoleKey(projectRef: string): Promise<string> {
  const keys = await getProjectKeys(projectRef);
  const serviceRole =
    keys.find((key) => key.name === "service_role" && key.api_key)?.api_key ??
    keys.find((key) => key.api_key?.startsWith("sb_secret_"))?.api_key;
  if (serviceRole !== undefined) return serviceRole;
  throw new Error(`Project ${projectRef} returned no service-role key`);
}

interface PoolerConfig {
  readonly database_type?: string;
  readonly connection_string?: string;
}

async function getPoolerSessionUrl(
  projectRef: string,
  password: string,
  timeoutMs = 180_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiBaseUrl()}/v1/projects/${projectRef}/config/database/pooler`,
      { headers: { Authorization: `Bearer ${accessToken()}` } },
    );
    lastStatus = String(response.status);
    if (response.ok) {
      const raw = (await response.json()) as PoolerConfig | PoolerConfig[];
      const configs = Array.isArray(raw) ? raw : [raw];
      const primary = configs.find((config) => config.database_type === "PRIMARY") ?? configs[0];
      if (primary?.connection_string !== undefined) {
        const url = new URL(primary.connection_string);
        url.password = password;
        url.port = "5432";
        if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "30");
        return url.toString();
      }
    } else {
      await response.body?.cancel();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10_000, remaining)));
  }
  throw new Error(
    `Failed to resolve pooler config for ${projectRef} within ${timeoutMs}ms (${lastStatus})`,
  );
}

async function createStorageBucket(
  projectRef: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<void> {
  const response = await fetch(`https://${projectRef}.${liveProjectHost()}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `Failed to create storage bucket ${bucket}: ${response.status} ${await response.text()}`,
    );
  }
}

/** Provision one unique staging project and all values needed by project live tests. */
export async function provisionManagedLiveProject(): Promise<LiveProjectEnvironment> {
  const orgId = await resolveOrgId();
  const baseName = process.env["SUPABASE_LIVE_PROJECT_NAME"] ?? "supabase-cli-live";
  const runId = process.env["GITHUB_RUN_ID"] ?? process.env["CI_JOB_ID"] ?? String(Date.now());
  const projectName = `${baseName}-${runId}-${randomUUID().slice(0, 8)}`;
  const dbPassword = generateDbPassword();
  const projectRef = await createProject(projectName, orgId, dbPassword);

  try {
    await waitForProjectReady(projectRef);
    const anonKey = await getAnonKey(projectRef);
    const serviceRoleKey = await getServiceRoleKey(projectRef);
    const dbUrl = await getPoolerSessionUrl(projectRef, dbPassword);
    const storageBucket = process.env["SUPABASE_LIVE_STORAGE_BUCKET"] ?? DEFAULT_STORAGE_BUCKET;
    await createStorageBucket(projectRef, serviceRoleKey, storageBucket);

    return {
      projectRef,
      anonKey,
      functionsUrl: `https://${projectRef}.${liveProjectHost()}/functions/v1`,
      dbUrl,
      dbPassword,
      storageBucket,
      projectName,
      owned: true,
    };
  } catch (error) {
    if (!keepLiveProject()) {
      await deleteProject(projectRef).catch((cleanupError) => {
        console.error(`Failed to delete managed live project ${projectRef}:`, cleanupError);
      });
    }
    throw error;
  }
}

export async function deleteManagedLiveProject(projectRef: string): Promise<void> {
  if (keepLiveProject()) {
    console.log(`SUPABASE_LIVE_KEEP_PROJECT=1 — leaving managed live project ${projectRef} alive`);
    return;
  }
  await deleteProject(projectRef);
}

/** Read-only API values supplied by an attached Supabox/local harness. */
export function attachedLiveValues(
  projectRef: string | undefined,
): Omit<LiveProjectEnvironment, "owned" | "projectName"> {
  const anonKey = process.env["SUPABASE_LIVE_ANON_KEY"] ?? "";
  const dbUrl = process.env["SUPABASE_LIVE_DB_URL"] ?? "";
  const dbPassword = process.env["SUPABASE_LIVE_DB_PASSWORD"] ?? "";
  const storageBucket = process.env["SUPABASE_LIVE_STORAGE_BUCKET"] ?? DEFAULT_STORAGE_BUCKET;
  return {
    projectRef: projectRef ?? "",
    anonKey,
    functionsUrl:
      process.env["SUPABASE_LIVE_FUNCTIONS_URL"] ??
      (projectRef === undefined ? "" : `https://${projectRef}.${liveProjectHost()}/functions/v1`),
    dbUrl,
    dbPassword,
    storageBucket,
  };
}

/** Resolve the attached environment without ever creating or deleting a project. */
export async function assertAttachedLiveReachable(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    await fetch(`${apiBaseUrl()}/v1/organizations`, { signal: controller.signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Live platform is not reachable at ${apiBaseUrl()}/v1/organizations: ${reason}.\n` +
        "Ensure the Supabox/local API platform is running and reachable.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
