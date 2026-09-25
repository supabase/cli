import { Effect, Schema } from "effect";

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

const TolerantString = Schema.String.pipe(
  Schema.catchDecoding(() => Effect.succeedSome("")),
  Schema.withDecodingDefaultKey(Effect.succeed("")),
);

const EMPTY_OWNER = { username: "" };

// Tolerant decode of the API response body. The real `/v1/snippets`
// payload omits optional fields the generated schema declares required, so
// routing through the typed client fails with `SchemaError: Missing key …`.
export const SnippetRow = Schema.Struct({
  id: TolerantString,
  name: TolerantString,
  visibility: TolerantString,
  owner: Schema.Struct({ username: TolerantString }).pipe(
    Schema.catchDecoding(() => Effect.succeedSome(EMPTY_OWNER)),
    Schema.withDecodingDefaultKey(Effect.succeed(EMPTY_OWNER)),
  ),
  inserted_at: TolerantString,
  updated_at: TolerantString,
}).pipe(
  Schema.catchDecoding(() =>
    Effect.succeedSome({
      id: "",
      name: "",
      visibility: "",
      owner: EMPTY_OWNER,
      inserted_at: "",
      updated_at: "",
    }),
  ),
);

export interface SnippetRow extends Schema.Schema.Type<typeof SnippetRow> {}

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
