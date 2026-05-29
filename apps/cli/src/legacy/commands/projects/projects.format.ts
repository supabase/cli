import type { ApiKeyResponse } from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";
import { apiKeyValue } from "../../shared/legacy-api-keys.format.ts";
import { formatLegacyTimestamp } from "../../shared/legacy-timestamp.format.ts";

// ---------------------------------------------------------------------------
// Pure formatters — no Effect / no service dependencies, kept unit-testable.
// Match Go's byte output for `projects list`, `projects create`, `projects
// api-keys`.
// ---------------------------------------------------------------------------

type ApiKey = typeof ApiKeyResponse.Type;

/**
 * Lenient project record. `projects list` / `create` parse the `/v1/projects`
 * response via the raw HTTP client because the typed client's `ref:
 * isMinLength(20)` + `^[a-z]+$` schema rejects the cli-e2e `__PROJECT_REF__`
 * placeholder fixtures (the same reason `legacySuggestUpgrade` and the
 * linked-project cache bypass the typed client). Projects therefore flow
 * through as plain JSON objects.
 */
export type LegacyLinkedProject = Readonly<Record<string, unknown>> & { readonly linked: boolean };

/** Read a string field from a parsed JSON value (empty string when absent/non-string). */
export function readProjectField(project: unknown, key: string): string {
  if (typeof project !== "object" || project === null) return "";
  const value = Reflect.get(project, key);
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// Region display names. Mirrors Go's `utils.regionMap` /
// `utils.FormatRegion` (`apps/cli-go/internal/utils/render.go:34-60`):
// known region codes render as a human-readable name; unknown codes pass
// through unchanged.
// ---------------------------------------------------------------------------

const REGION_MAP: Readonly<Record<string, string>> = {
  "ap-east-1": "East Asia (Hong Kong)",
  "ap-northeast-1": "Northeast Asia (Tokyo)",
  "ap-northeast-2": "Northeast Asia (Seoul)",
  "ap-south-1": "South Asia (Mumbai)",
  "ap-southeast-1": "Southeast Asia (Singapore)",
  "ap-southeast-2": "Oceania (Sydney)",
  "ca-central-1": "Canada (Central)",
  "eu-central-1": "Central EU (Frankfurt)",
  "eu-central-2": "Central Europe (Zurich)",
  "eu-north-1": "North EU (Stockholm)",
  "eu-west-1": "West EU (Ireland)",
  "eu-west-2": "West Europe (London)",
  "eu-west-3": "West EU (Paris)",
  "sa-east-1": "South America (São Paulo)",
  "us-east-1": "East US (North Virginia)",
  "us-east-2": "East US (Ohio)",
  "us-west-1": "West US (North California)",
  "us-west-2": "West US (Oregon)",
};

export function formatRegion(region: string): string {
  return REGION_MAP[region] ?? region;
}

// ---------------------------------------------------------------------------
// Dashboard URL per profile. Mirrors Go's `utils.GetSupabaseDashboardURL` ->
// `CurrentProfile.DashboardURL` (`apps/cli-go/internal/utils/profile.go:30-91`).
// Defaults to the production dashboard for unknown / file-based profiles.
// ---------------------------------------------------------------------------

const DASHBOARD_URLS: Readonly<Record<string, string>> = {
  supabase: "https://supabase.com/dashboard",
  "supabase-staging": "https://supabase.green/dashboard",
  "supabase-local": "http://localhost:8082",
};

export function dashboardUrlForProfile(profile: string): string {
  return DASHBOARD_URLS[profile] ?? DASHBOARD_URLS.supabase!;
}

// ---------------------------------------------------------------------------
// Tables. `renderGlamourTable` lays out cells directly, so literal `|` in a
// project name flows through unescaped and matches Go's glamour byte output
// (the markdown `\|` escape is decoded back to `|` by glamour upstream).
// ---------------------------------------------------------------------------

const LIST_HEADERS = [
  "LINKED",
  "ORG ID",
  "REFERENCE ID",
  "NAME",
  "REGION",
  "CREATED AT (UTC)",
] as const;

const CREATE_HEADERS = ["ORG ID", "REFERENCE ID", "NAME", "REGION", "CREATED AT (UTC)"] as const;

const API_KEYS_HEADERS = ["NAME", "KEY VALUE"] as const;

/** Go's `formatBullet` (`list.go:73-78`): bullet for the linked project. */
function formatBullet(linked: boolean): string {
  return linked ? "  ●" : " ";
}

/**
 * Reproduces Go's `projects list` pretty table (`list.go:44-59`). The REFERENCE
 * ID and LINKED-marker comparison both use the project `id` field, matching
 * Go's use of `project.Id`.
 */
export function renderProjectsListTable(projects: ReadonlyArray<LegacyLinkedProject>): string {
  const rows = projects.map((project) => [
    formatBullet(project.linked),
    readProjectField(project, "organization_slug"),
    readProjectField(project, "id"),
    readProjectField(project, "name"),
    formatRegion(readProjectField(project, "region")),
    formatLegacyTimestamp(readProjectField(project, "created_at")),
  ]);
  return renderGlamourTable(LIST_HEADERS, rows);
}

/** Reproduces Go's `projects create` pretty table (`create.go:36-47`). */
export function renderProjectCreateTable(project: unknown): string {
  const rows = [
    [
      readProjectField(project, "organization_slug"),
      readProjectField(project, "id"),
      readProjectField(project, "name"),
      formatRegion(readProjectField(project, "region")),
      formatLegacyTimestamp(readProjectField(project, "created_at")),
    ],
  ];
  return renderGlamourTable(CREATE_HEADERS, rows);
}

/**
 * Reproduces Go's `projects api-keys` pretty table (`api_keys.go:23-33`):
 * the KEY VALUE column shows `******` when the api key is nullable-null.
 */
export function renderProjectApiKeysTable(keys: ReadonlyArray<ApiKey>): string {
  const rows = keys.map((entry) => [entry.name, apiKeyValue(entry.api_key)]);
  return renderGlamourTable(API_KEYS_HEADERS, rows);
}
