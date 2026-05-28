import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";
import { formatLegacyTimestamp } from "../../shared/legacy-timestamp.format.ts";

const HEADERS = [
  "ID",
  "NAME",
  "VISIBILITY",
  "OWNER",
  "CREATED AT (UTC)",
  "UPDATED AT (UTC)",
] as const;

// Reproduces `strings.ReplaceAll(value, "|", "\\|")` from
// `apps/cli-go/internal/snippets/list/list.go:33-36`; every cell that can
// contain user-provided text needs this escape so markdown table parsers
// don't split the cell on an embedded pipe.
export function escapePipe(value: string): string {
  return value.replaceAll("|", "\\|");
}

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
    escapePipe(snippet.name),
    escapePipe(snippet.visibility),
    escapePipe(snippet.owner.username),
    formatLegacyTimestamp(snippet.inserted_at),
    formatLegacyTimestamp(snippet.updated_at),
  ]);
  return renderGlamourTable(HEADERS, rows);
}
