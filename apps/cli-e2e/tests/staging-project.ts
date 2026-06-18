import { randomBytes } from "node:crypto";
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

// Project statuses from which provisioning never recovers — fast-fail instead of
// polling to the timeout.
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);

/** A DB password for a throwaway project, used at creation and to build the live
 *  --db-url. Randomised per call (overridable via CLI_E2E_DB_PASSWORD) so no
 *  static credential is committed — the project is deleted on teardown anyway.
 *  Each setup generates its own and routes it through provide()/inject() rather
 *  than sharing a module-level export. */
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

// `throwOnError` surfaces a failed deletion (live teardown uses it so a leaked
// staging project fails the run loudly; record setup keeps the lenient default).
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
      if (project.status && TERMINAL_BAD_STATUSES.has(project.status)) {
        throw new Error(
          `Project ${projectRef} entered terminal status ${project.status} during provisioning`,
        );
      }
    } else {
      await res.body?.cancel(); // free the socket before sleeping
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Project ${projectRef} did not become ACTIVE_HEALTHY within ${timeoutMs}ms`);
}

interface ApiKey {
  name?: string;
  api_key?: string;
}

/** Resolve a key for invoking the project's deployed functions over HTTP.
 *  Prefers the legacy `anon` JWT: Edge Functions default to verify_jwt=true and
 *  a publishable (sb_publishable_) key is NOT a JWT, so it fails the platform
 *  JWT check on a verified function. Falls back to the publishable key for
 *  projects that only issue new-style keys. Even after ACTIVE_HEALTHY the
 *  api-keys endpoint can briefly 4xx, so retry. */
export async function getAnonKey(
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
      const anonJwt = keys.find((k) => k.name === "anon" && k.api_key)?.api_key;
      if (anonJwt) return anonJwt;
      // Keys present but no legacy anon JWT. A publishable (sb_publishable_) key
      // is NOT a JWT and 401s on the default verify_jwt=true functions, so fail
      // loudly rather than proceed with a key that can't authenticate verified
      // invokes (the suite would need to deploy with --no-verify-jwt instead).
      if (keys.length > 0) {
        throw new Error(
          `Project ${projectRef} returned no anon JWT (only new-style keys); verified-function invokes require a JWT`,
        );
      }
    } else if (attempt < attempts) {
      await res.body?.cancel(); // free the socket before sleeping
    }
    if (attempt === attempts) {
      const detail = res.bodyUsed ? res.status : await res.text().catch(() => res.status);
      throw new Error(
        `Failed to resolve anon key for ${projectRef} after ${attempts} attempts: ${detail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  // Unreachable — the loop either returns a key or throws on the last attempt.
  throw new Error(`Failed to resolve anon key for ${projectRef}`);
}

/** Service-role / secret key, used to seed a storage bucket for the live storage
 *  tests (the same way record setup does). Retries like getAnonKey. */
export async function getServiceRoleKey(
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
      const secret =
        keys.find((k) => k.name === "service_role" && k.api_key)?.api_key ??
        keys.find((k) => k.api_key?.startsWith("sb_secret_"))?.api_key;
      if (secret) return secret;
    } else {
      await res.body?.cancel(); // free the socket before sleeping
    }
    if (attempt === attempts) {
      throw new Error(`Failed to resolve service-role key for ${projectRef}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`Failed to resolve service-role key for ${projectRef}`);
}

/** Create a private storage bucket via the project's Storage API (host derived
 *  from projectHost, IPv4-reachable). Idempotent — treats an existing bucket as
 *  success. */
export async function createStorageBucket(
  projectHost: string,
  projectRef: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<void> {
  const res = await fetch(`https://${projectRef}.${projectHost}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create bucket ${bucket}: ${res.status} ${await res.text()}`);
  }
}

interface PoolerConfig {
  database_type?: string;
  connection_string?: string;
}

/** Build a SESSION-mode (port 5432) Supavisor pooler connection string for the
 *  project's Postgres. The direct host (db.<ref>...) is IPv6-only and unreachable
 *  from IPv4-only CI runners, so DB commands go through the pooler, which is IPv4.
 *  Session mode (not the API's default transaction 6543) is required for pg_dump
 *  (`db dump`).
 *
 *  Reuses the Management API's `connection_string` verbatim — it carries tenant
 *  routing (e.g. options=reference=... query params) that a field-reconstructed
 *  URL would drop — and only swaps in our password and the session port. Mirrors
 *  the Go connector by selecting the PRIMARY pooler config. */
export async function getPoolerSessionUrl(
  apiBaseUrl: string,
  projectRef: string,
  password: string,
  attempts = 12,
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(`${apiBaseUrl}/v1/projects/${projectRef}/config/database/pooler`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (res.ok) {
      const raw = (await res.json()) as PoolerConfig | PoolerConfig[];
      const configs = Array.isArray(raw) ? raw : [raw];
      const primary = configs.find((c) => c.database_type === "PRIMARY") ?? configs[0];
      if (primary?.connection_string) {
        const url = new URL(primary.connection_string);
        url.password = password; // overwrites the [YOUR-PASSWORD] placeholder (URL-encoded)
        url.port = "5432"; // session mode (API returns the 6543 transaction port)
        if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "30");
        return url.toString();
      }
    } else if (attempt < attempts) {
      await res.body?.cancel(); // free the socket before sleeping
    }
    if (attempt === attempts) {
      const detail = res.bodyUsed ? res.status : await res.text().catch(() => res.status);
      throw new Error(
        `Failed to resolve pooler config for ${projectRef} after ${attempts} attempts: ${detail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  // Unreachable — the loop either returns a URL or throws on the last attempt.
  throw new Error(`Failed to resolve pooler config for ${projectRef}`);
}
