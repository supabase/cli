import type { ApiKeyResponse_Output } from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/glamour-table.ts";
import { apiKeyValue } from "../../command-internal/api-keys.format.ts";
import { formatRegion } from "../../command-internal/region.format.ts";
import { formatTimestamp } from "../../command-internal/timestamp.format.ts";

type ApiKey = typeof ApiKeyResponse_Output.Type;

/**
 * Lenient project record. `projects list`/`create` read the `/v1/projects` response without
 * schema decoding, so projects flow through as plain JSON objects exactly as the API returned them.
 */
export type LinkedProject = Readonly<Record<string, unknown>> & { readonly linked: boolean };

/** Read a string field from a parsed JSON value (empty string when absent/non-string). */
export function readProjectField(project: unknown, key: string): string {
  if (typeof project !== "object" || project === null) return "";
  const value = Reflect.get(project, key);
  return typeof value === "string" ? value : "";
}

// Dashboard URL per profile. Defaults to the production dashboard for
// unknown / file-based profiles.

const PRODUCTION_DASHBOARD_URL = "https://supabase.com/dashboard";

const DASHBOARD_URLS: Readonly<Record<string, string>> = {
  supabase: PRODUCTION_DASHBOARD_URL,
  "supabase-staging": "https://supabase.green/dashboard",
  "supabase-local": "http://localhost:8082",
};

export function dashboardUrlForProfile(profile: string): string {
  return DASHBOARD_URLS[profile] ?? PRODUCTION_DASHBOARD_URL;
}

// `renderGlamourTable` lays out cells directly, so a literal `|` in a project name passes
// through unescaped.
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

/** Bullet marker for the linked project. */
function formatBullet(linked: boolean): string {
  return linked ? "  ●" : " ";
}

/**
 * `projects list` pretty table. The REFERENCE ID and LINKED-marker
 * comparison both use the project `id` field.
 */
export function renderProjectsListTable(projects: ReadonlyArray<LinkedProject>): string {
  const rows = projects.map((project) => [
    formatBullet(project.linked),
    readProjectField(project, "organization_slug"),
    readProjectField(project, "id"),
    readProjectField(project, "name"),
    formatRegion(readProjectField(project, "region")),
    formatTimestamp(readProjectField(project, "created_at")),
  ]);
  return renderGlamourTable(LIST_HEADERS, rows);
}

/** `projects create` pretty table. */
export function renderProjectCreateTable(project: unknown): string {
  const rows = [
    [
      readProjectField(project, "organization_slug"),
      readProjectField(project, "id"),
      readProjectField(project, "name"),
      formatRegion(readProjectField(project, "region")),
      formatTimestamp(readProjectField(project, "created_at")),
    ],
  ];
  return renderGlamourTable(CREATE_HEADERS, rows);
}

/**
 * `projects api-keys` pretty table: the KEY VALUE column shows `******`
 * when the api key is nullable-null.
 */
export function renderProjectApiKeysTable(keys: ReadonlyArray<ApiKey>): string {
  const rows = keys.map((entry) => [entry.name, apiKeyValue(entry.api_key)]);
  return renderGlamourTable(API_KEYS_HEADERS, rows);
}
