import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";
import { formatLegacyTimestamp } from "../../shared/legacy-timestamp.format.ts";

// ---------------------------------------------------------------------------
// Pure formatter — no Effect / no service dependencies, kept unit-testable.
//
// A markdown-table + glamour pipeline wraps each cell in backticks with
// `strings.ReplaceAll(value, "|", "\\|")` applied; glamour then decodes the
// `\|` escape and strips the backticks, so the final ASCII bytes contain raw
// `|` (not `\|`). `renderGlamourTable` lays out cells directly without the
// markdown round-trip, so we pass raw values — any `|` in `name`,
// `visibility`, or `owner.username` appears literally in stdout. (Same rule
// documented in orgs.format.ts.)
//
// Note: API-supplied strings are NOT stripped of ANSI escape sequences or
// other terminal control bytes before rendering. If a future security review
// decides to sanitize, it should land at the renderer
// (`legacy-glamour-table.ts`), not per-command.
// ---------------------------------------------------------------------------

const HEADERS = [
  "ID",
  "NAME",
  "VISIBILITY",
  "OWNER",
  "CREATED AT (UTC)",
  "UPDATED AT (UTC)",
] as const;

export interface SnippetRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: string;
  readonly owner: { readonly username: string };
  readonly inserted_at: string;
  readonly updated_at: string;
}

export function renderSnippetsTable(items: ReadonlyArray<SnippetRow>): string {
  const rows = items.map((snippet) => [
    snippet.id,
    snippet.name,
    snippet.visibility,
    snippet.owner.username,
    formatLegacyTimestamp(snippet.inserted_at),
    formatLegacyTimestamp(snippet.updated_at),
  ]);
  return renderGlamourTable(HEADERS, rows);
}
