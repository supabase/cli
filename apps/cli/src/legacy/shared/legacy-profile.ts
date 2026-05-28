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
}

const BUILT_IN: Readonly<Record<string, LegacyProfileEndpoints>> = {
  supabase: { projectHost: "supabase.co", dashboardUrl: "https://supabase.com/dashboard" },
  "supabase-staging": {
    projectHost: "supabase.red",
    dashboardUrl: "https://supabase.green/dashboard",
  },
  "supabase-local": {
    projectHost: "supabase.red",
    dashboardUrl: "http://localhost:8082",
  },
};

const DEFAULT_ENDPOINTS: LegacyProfileEndpoints = BUILT_IN.supabase!;

export function legacyProjectHost(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).projectHost;
}

export function legacyDashboardUrl(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).dashboardUrl;
}

export function legacyBillingUrl(profile: string, orgSlug: string): string {
  return `${legacyDashboardUrl(profile)}/org/${orgSlug}/billing`;
}
