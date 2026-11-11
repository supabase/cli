import type { OrganizationResponseV1_Output } from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/glamour-table.ts";

// TODO: the terminal table could add Plan (one `GET /v1/organizations/{slug}` per org) and a
// project count (one `GET /v1/projects`); keep piped output to ID and NAME.
const HEADERS = [
  { piped: "ID", terminal: "ID", kind: "id" },
  { piped: "NAME", terminal: "Name", kind: "primary" },
] as const;

type Organization = typeof OrganizationResponseV1_Output.Type;

/**
 * Renders the `orgs list` / `orgs create` table.
 *
 * `renderGlamourTable` lays out cells directly, so raw `id`/`name` values pass through
 * unescaped — including any literal `|` and without stripping ANSI or other control bytes,
 * matching established output. Add sanitization in `renderGlamourTable` if it's ever needed,
 * not here.
 */
export function renderOrgsListTable(orgs: ReadonlyArray<Organization>): string {
  const rows = orgs.map((o) => [o.id, o.name]);
  return renderGlamourTable(HEADERS, rows, process.stdout, "No organizations");
}
