/**
 * Environment-only helpers for the `live` Vitest project, with **no Vitest test
 * APIs imported**. Vitest evaluates `globalSetup` (live-global-setup.ts) in a
 * separate context before the test workers, where importing `describe`/`test`
 * is not valid — so the global setup imports the env helpers from here, while
 * the test-facing pieces (`describeLive`, `runSupabaseLive`, …) live in
 * `live.ts` and re-export these.
 *
 * Environment contract (provided by the cli-e2e-ci runner):
 * - `SUPABASE_ACCESS_TOKEN` — required; the platform PAT (supabox seeds a
 *   deterministic `sbp_…` token into its mgmt-api database).
 * - `SUPABASE_PROFILE` — selects the API base URL; defaults to `supabase-local`
 *   (→ `http://localhost:8080`, `project_host: supabase.red`). Note the cli does
 *   NOT honor `SUPABASE_API_URL` (Go parity) — the profile is the override.
 * - `SUPABASE_LIVE_API_URL` — base URL the readiness check probes; attached
 *   mode defaults to `http://localhost:8080`, managed staging defaults to
 *   `https://api.supabase.green`.
 * - `SUPABASE_LIVE_PROJECT_REF` — a provisioned project; gates project-scoped
 *   suites (functions, branches, db, storage).
 * - `NODE_EXTRA_CA_CERTS` — trusts the supabox CA for `*.supabase.red` TLS;
 *   inherited by the subprocess via the parent environment.
 */

/** Default profile for the host runner: api_url → localhost:8080, project_host → supabase.red. */
export const LIVE_DEFAULT_PROFILE = "supabase-local";

export type LiveMode = "attached" | "managed";

/**
 * Selects how the run-scoped live environment is obtained.
 *
 * The default is deliberately attached: a token in a developer's environment
 * must never cause the test suite to create or delete a project. Managed mode
 * is an explicit opt-in for staging runs and is selected with
 * `SUPABASE_LIVE_MODE=managed`.
 */
export function liveMode(): LiveMode {
  const value = process.env["SUPABASE_LIVE_MODE"];
  if (value === undefined || value === "" || value === "attached") {
    return "attached";
  }
  if (value === "managed") {
    return "managed";
  }
  throw new Error(
    `Unsupported SUPABASE_LIVE_MODE ${JSON.stringify(value)}; expected "attached" or "managed"`,
  );
}

export function isManagedLive(): boolean {
  return liveMode() === "managed";
}

/**
 * Default subprocess exit timeout for live runs. `runSupabase` otherwise caps at
 * 60s, which would kill a slow-but-valid supabox call before the live tests'
 * own (60–120s+) timeouts fire. Generous, but under the `live` project's 300s
 * cap so the per-test timeout stays the real gate. Callers may override.
 */
export const LIVE_EXIT_TIMEOUT_MS = 240_000;

/** Management API base URL probed by the live readiness check. */
export function liveApiBaseUrl(): string {
  return (
    process.env["SUPABASE_LIVE_API_URL"] ??
    (isManagedLive() ? "https://api.supabase.green" : "http://localhost:8080")
  );
}

/** Profile used by the CLI subprocess. Attached runs preserve the historical
 * local Supabox default; managed staging runs use the built-in staging profile
 * unless the caller explicitly selected another profile. */
export function liveProfile(): string {
  return (
    process.env["SUPABASE_PROFILE"] ?? (isManagedLive() ? "supabase-staging" : LIVE_DEFAULT_PROFILE)
  );
}

/** Host used for project-scoped endpoints such as Edge Functions and Storage. */
export function liveProjectHost(): string {
  if (process.env["SUPABASE_LIVE_PROJECT_HOST"] !== undefined) {
    return process.env["SUPABASE_LIVE_PROJECT_HOST"]!;
  }

  switch (liveProfile()) {
    case "supabase":
      return "supabase.co";
    case "supabase-staging":
    case "supabase-local":
      return "supabase.red";
    default:
      return "supabase.red";
  }
}

/** Keep an explicitly managed project alive for debugging instead of deleting it. */
export function keepLiveProject(): boolean {
  return process.env["SUPABASE_LIVE_KEEP_PROJECT"] === "1";
}

/**
 * True when the environment carries a platform access token, i.e. the live
 * suite is expected to run. Used to gate `describeLive` so live tests are inert
 * in the default test loop.
 */
export function isLiveConfigured(): boolean {
  return Boolean(process.env["SUPABASE_ACCESS_TOKEN"]);
}

/**
 * Project ref for project-scoped live scenarios (functions, branches, db,
 * storage, …). The cli-e2e-ci runner sets this once a project has been
 * provisioned on the stack; absent → those suites skip. Returns `undefined`
 * when unset so callers can branch; use `requireLiveProjectRef` inside a
 * `describeLiveProject` block where presence is already guaranteed.
 */
export function liveProjectRef(): string | undefined {
  return process.env["SUPABASE_LIVE_PROJECT_REF"];
}

/**
 * The live project ref, or a thrown error if unset. Safe to call inside a
 * `describeLiveProject` block (the gate guarantees it is present) and gives a
 * typed `string` without a non-null assertion.
 */
export function requireLiveProjectRef(): string {
  const ref = liveProjectRef();
  if (!ref) {
    throw new Error(
      "SUPABASE_LIVE_PROJECT_REF must be set for project-scoped live tests " +
        "(the cli-e2e-ci runner sets it after provisioning a project).",
    );
  }
  return ref;
}

/**
 * Whether the live project's *data-plane* — its own Postgres instance — is up
 * and healthy. This is a stronger gate than `liveProjectRef()`: cli-e2e-ci
 * currently builds the stack WITHOUT `supabase-postgres-17` (CLI-1825), so a
 * provisioned project's *record* exists — Management-API reads (orgs / projects
 * / functions / branches list) work — but the instance never reaches
 * `ACTIVE_HEALTHY` and its database is unreachable. Commands that talk to the
 * project Postgres (migration, db, storage) gate on this and SKIP until the full
 * stack lands, then activate automatically.
 *
 * Probes `GET /v1/projects` (already proven reachable by `projects list`) and
 * matches the live ref. Any failure or missing prerequisite returns `false` —
 * "not ready" is the safe default, so a probe error skips rather than fails the
 * suite.
 */
export async function liveProjectDataPlaneReady(): Promise<boolean> {
  const token = process.env["SUPABASE_ACCESS_TOKEN"];
  const ref = liveProjectRef();
  if (token === undefined || token.length === 0 || ref === undefined) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${liveApiBaseUrl()}/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const projects: unknown = await response.json();
    if (!Array.isArray(projects)) {
      return false;
    }
    return projects.some(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        "ref" in candidate &&
        candidate.ref === ref &&
        "status" in candidate &&
        candidate.status === "ACTIVE_HEALTHY",
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
