import type { OrganizationResponseV1 } from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/glamour-table.ts";

const HEADERS = ["ID", "NAME"] as const;

type Organization = typeof OrganizationResponseV1.Type;

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
  return renderGlamourTable(HEADERS, rows);
}
