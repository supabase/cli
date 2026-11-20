import type { DocsFlag } from "./docs-spec.ts";

/**
 * Static data the Effect command tree cannot express structurally: argument usage exceptions
 * and query-specific output formats. `buildDocsSpec` fails the build on stale keys.
 */

/**
 * Flag docs injected into specific commands beyond what their Effect config
 * declares, keyed by doc id. `db query` reuses the global `-o, --output`
 * choice at parse time (which documents only the globally valid formats), so
 * its own page documents the query-specific formats here.
 */
export const DOCS_EXTRA_FLAGS: Readonly<Record<string, ReadonlyArray<DocsFlag>>> = {
  "supabase-db-query": [
    {
      id: "output",
      name: "-o, --output <[ json | table | csv ]>",
      description: "Output format: table, json, or csv.",
      default_value: "json",
      accepted_values: [
        { id: "json", name: "json", type: "[ json | table | csv ]" },
        { id: "table", name: "table", type: "[ json | table | csv ]" },
        { id: "csv", name: "csv", type: "[ json | table | csv ]" },
      ],
    },
  ],
};

/**
 * Usage argument overrides, keyed by doc id, for commands whose published argument rendering
 * can't be derived from the Effect tree: the parser accepts zero occurrences here
 * (`secrets set --env-file` passes no positionals; `storage rm` validates in the handler), but
 * the documented shape is required.
 */
export const DOCS_ARG_OVERRIDES: Readonly<Record<string, string>> = {
  "supabase-secrets-set": "<NAME=VALUE> ...",
  "supabase-storage-rm": "<file> ...",
};

export const DOCS_INFO_DESCRIPTION =
  "Supabase CLI provides you with tools to develop your application locally, and deploy your application to the Supabase platform.";
