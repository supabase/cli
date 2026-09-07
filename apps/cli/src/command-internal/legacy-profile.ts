/**
 * Built-in profile → environment endpoints. Mirrors the `allProfiles` table.
 * Both `project_host` (used
 * to build `SUPABASE_URL = https://<ref>.<host>` for `branches get`) and
 * `dashboard_url` (used by `legacySuggestUpgrade` to build the billing URL)
 * live here so we have a single source of truth.
 *
 * YAML-mode profiles carry their own `project_host` and `dashboard_url`
 * (both `required`, loaded by `legacyLoadProfile`). The `?? DEFAULT_ENDPOINTS`
 * fallbacks below only serve callers that key a lookup on an already-resolved
 * profile NAME, which for a YAML profile is its `name:` field, not a table key.
 */

import type { LegacyProfileName } from "../config/legacy-cli-settings.service.ts";

interface LegacyProfileEndpoints {
  /** Management API base URL (`Profile.APIURL`). */
  readonly apiUrl: string;
  readonly projectHost: string;
  readonly dashboardUrl: string;
  /**
   * eTLD+1 the connection pooler hostname must belong to
   * (`Profile.PoolerHost`). Empty string means "no pooler-domain
   * assertion" (`supabase-local`). Used by the linked db-config resolver's
   * MITM domain check.
   */
  readonly poolerHost: string;
}

const BUILT_IN: Readonly<Record<string, LegacyProfileEndpoints>> = {
  supabase: {
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    dashboardUrl: "https://supabase.com/dashboard",
    poolerHost: "supabase.com",
  },
  "supabase-staging": {
    apiUrl: "https://api.supabase.green",
    projectHost: "supabase.red",
    dashboardUrl: "https://supabase.green/dashboard",
    poolerHost: "supabase.green",
  },
  "supabase-local": {
    apiUrl: "http://localhost:8080",
    projectHost: "supabase.red",
    dashboardUrl: "http://localhost:8082",
    poolerHost: "",
  },
  snap: {
    apiUrl: "https://cloudapi.snap.com",
    projectHost: "snapcloud.dev",
    dashboardUrl: "https://cloud.snap.com/dashboard",
    poolerHost: "snapcloud.co",
  },
};

/**
 * Exact-match (case-sensitive) built-in profile-name guard. Go matches
 * built-in names with `strings.EqualFold`; callers that
 * need Go's fold semantics lower-case the candidate first (all four built-in
 * names are already lower-case).
 */
export function legacyIsBuiltinProfileName(profile: string): profile is LegacyProfileName {
  return profile in BUILT_IN;
}

const DEFAULT_ENDPOINTS: LegacyProfileEndpoints = BUILT_IN.supabase!;

export function legacyApiUrl(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).apiUrl;
}

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
