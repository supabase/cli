/**
 * Built-in profile → environment endpoints, the single source of truth for `project_host`
 * (used to build `SUPABASE_URL = https://<ref>.<host>`) and `dashboard_url` (used to build the
 * billing URL).
 *
 * YAML-mode profiles carry their own `project_host`/`dashboard_url` (loaded by `loadProfile`).
 * The `?? DEFAULT_ENDPOINTS` fallbacks below only serve callers keying a lookup on an
 * already-resolved profile name, which for a YAML profile is its `name:` field, not a table key.
 */

import type { ProfileName } from "../config/command-settings.service.ts";

interface ProfileEndpoints {
  /** Management API base URL. */
  readonly apiUrl: string;
  readonly projectHost: string;
  readonly dashboardUrl: string;
  /**
   * eTLD+1 the connection pooler hostname must belong to. Empty string means no
   * pooler-domain assertion (`supabase-local`). Used by the linked db-config resolver's MITM
   * domain check.
   */
  readonly poolerHost: string;
}

const BUILT_IN: Readonly<Record<string, ProfileEndpoints>> = {
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
 * Exact-match (case-sensitive) built-in profile-name guard. Callers that need
 * case-insensitive matching lower-case the candidate first (all four built-in names are
 * already lower-case).
 */
export function isBuiltinProfileName(profile: string): profile is ProfileName {
  return profile in BUILT_IN;
}

const DEFAULT_ENDPOINTS: ProfileEndpoints = BUILT_IN.supabase!;

export function apiUrl(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).apiUrl;
}

export function projectHost(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).projectHost;
}

export function dashboardUrl(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).dashboardUrl;
}

export function poolerHost(profile: string): string {
  return (BUILT_IN[profile] ?? DEFAULT_ENDPOINTS).poolerHost;
}

export function billingUrl(profile: string, orgSlug: string): string {
  return `${dashboardUrl(profile)}/org/${orgSlug}/billing`;
}
