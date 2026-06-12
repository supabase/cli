/**
 * Built-in profile → environment endpoints. Mirrors the `allProfiles` table
 * in `apps/cli-go/internal/utils/profile.go:30-91`. Both `project_host` (used
 * to build `SUPABASE_URL = https://<ref>.<host>` for `branches get`) and
 * `dashboard_url` (used by `legacySuggestUpgrade` to build the billing URL)
 * live here so we have a single source of truth.
 *
 * YAML-mode profiles do not currently carry `project_host` or `dashboard_url`
 * in the TS port; they fall back to the production endpoints, matching Go's
 * behavior when an external profile YAML omits those keys.
 */

interface LegacyProfileEndpoints {
  readonly projectHost: string;
  readonly dashboardUrl: string;
  /**
   * eTLD+1 the connection pooler hostname must belong to (Go's
   * `Profile.PoolerHost`, `profile.go:24`). Empty string means "no pooler-domain
   * assertion" (Go's `supabase-local`). Used by the linked db-config resolver's
   * MITM domain check.
   */
  readonly poolerHost: string;
}

const BUILT_IN: Readonly<Record<string, LegacyProfileEndpoints>> = {
  supabase: {
    projectHost: "supabase.co",
    dashboardUrl: "https://supabase.com/dashboard",
    poolerHost: "supabase.com",
  },
  "supabase-staging": {
    projectHost: "supabase.red",
    dashboardUrl: "https://supabase.green/dashboard",
    poolerHost: "supabase.green",
  },
  "supabase-local": {
    projectHost: "supabase.red",
    dashboardUrl: "http://localhost:8082",
    poolerHost: "",
  },
  snap: {
    projectHost: "snapcloud.dev",
    dashboardUrl: "https://cloud.snap.com/dashboard",
    poolerHost: "snapcloud.co",
  },
};

const DEFAULT_ENDPOINTS: LegacyProfileEndpoints = BUILT_IN.supabase!;

export function legacyProjectHost(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).projectHost;
}

export function legacyDashboardUrl(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).dashboardUrl;
}

export function legacyPoolerHost(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).poolerHost;
}

export function legacyBillingUrl(profile: string, orgSlug: string): string {
  return `${legacyDashboardUrl(profile)}/org/${orgSlug}/billing`;
}
