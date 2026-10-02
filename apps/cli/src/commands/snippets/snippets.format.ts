import { renderGlamourTable } from "../../output/glamour-table.ts";
import { formatTimestamp } from "../../command-internal/timestamp.format.ts";

// `renderGlamourTable` lays out cells directly, bypassing glamour's markdown
// escaping, so any `|` in `name`, `visibility`, or `owner.username` appears
// literally in stdout (same rule as orgs.format.ts).
//
// API-supplied strings are not stripped of ANSI/control bytes before
// rendering; a future sanitization pass belongs in the renderer
// (glamour-table.ts), not per-command.

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
    formatTimestamp(snippet.inserted_at),
    formatTimestamp(snippet.updated_at),
  ]);
  return renderGlamourTable(HEADERS, rows);
}
