import type { OrganizationResponseV1 } from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";

// ---------------------------------------------------------------------------
// Pure formatter — no Effect / no service dependencies, kept unit-testable.
//
// A markdown-table + glamour pipeline wraps each cell in backticks and
// escapes `|` as `\|` in the markdown intermediate; glamour decodes the
// escape and strips the backticks. Our `renderGlamourTable` lays out cells
// directly, so we pass raw values (including any literal `|`).
//
// Note: API-supplied `id` / `name` strings are NOT stripped of ANSI escape
// sequences or other terminal control bytes before rendering — diverging
// here would mean scripts grepping table cells see different bytes than they
// do today. If a future security review decides to sanitize, it should land
// for both shells at the renderer (`legacy-glamour-table.ts`), not
// per-command.
// ---------------------------------------------------------------------------

const HEADERS = ["ID", "NAME"] as const;

type Organization = typeof OrganizationResponseV1.Type;

export function renderOrgsListTable(orgs: ReadonlyArray<Organization>): string {
  const rows = orgs.map((o) => [o.id, o.name]);
  return renderGlamourTable(HEADERS, rows);
}
