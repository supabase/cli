import type { DocsFlag } from "./docs-spec.ts";

/**
 * Static data the Effect command tree cannot express structurally: docs-site section tags,
 * `--experimental`-required leaves, deprecated commands, argument usage exceptions and
 * query-specific output formats. `buildDocsSpec` fails the build on stale keys.
 */

export interface DocsInfoTag {
  readonly id: string;
  readonly title: string;
}

export const DOCS_INFO_TAGS: ReadonlyArray<DocsInfoTag> = [
  { id: "quick-start", title: "Quick Start" },
  { id: "local-dev", title: "Local Development" },
  { id: "management-api", title: "Management APIs" },
  { id: "other-commands", title: "Additional Commands" },
];

/** Docs-site section tag per top-level command. */
export const DOCS_TAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "supabase-bootstrap": ["quick-start"],
  "supabase-backups": ["management-api"],
  "supabase-branches": ["management-api"],
  "supabase-completion": ["other-commands"],
  "supabase-config": ["management-api"],
  "supabase-db": ["local-dev"],
  "supabase-domains": ["management-api"],
  "supabase-encryption": ["management-api"],
  "supabase-feedback": ["other-commands"],
  "supabase-functions": ["management-api"],
  "supabase-gen": ["local-dev"],
  "supabase-init": ["local-dev"],
  "supabase-inspect": ["local-dev"],
  "supabase-issue": ["other-commands"],
  "supabase-link": ["local-dev"],
  "supabase-login": ["local-dev"],
  "supabase-logout": ["local-dev"],
  "supabase-logs": ["management-api", "local-dev"],
  "supabase-migration": ["local-dev"],
  "supabase-network-bans": ["management-api"],
  "supabase-network-restrictions": ["management-api"],
  "supabase-notebooks": ["management-api"],
  "supabase-orgs": ["management-api"],
  "supabase-postgres-config": ["management-api"],
  "supabase-projects": ["management-api"],
  "supabase-pull": ["other-commands"],
  "supabase-secrets": ["management-api"],
  "supabase-seed": ["local-dev"],
  "supabase-services": ["local-dev"],
  "supabase-snippets": ["management-api"],
  "supabase-ssl-enforcement": ["management-api"],
  "supabase-sso": ["management-api"],
  "supabase-start": ["local-dev"],
  "supabase-status": ["local-dev"],
  "supabase-stop": ["local-dev"],
  "supabase-storage": ["management-api"],
  "supabase-telemetry": ["local-dev"],
  "supabase-test": ["local-dev"],
  "supabase-unlink": ["local-dev"],
  "supabase-vanity-subdomains": ["management-api"],
  "supabase-whoami": ["management-api"],
};

/** Leaves that require `--experimental`. */
export const DOCS_EXPERIMENTAL: ReadonlySet<string> = new Set([
  "supabase-network-bans-get",
  "supabase-network-bans-remove",
  "supabase-network-restrictions-get",
  "supabase-network-restrictions-update",
  "supabase-postgres-config-delete",
  "supabase-postgres-config-get",
  "supabase-postgres-config-update",
  "supabase-ssl-enforcement-get",
  "supabase-ssl-enforcement-update",
  "supabase-storage-cp",
  "supabase-storage-ls",
  "supabase-storage-mv",
  "supabase-storage-rm",
  "supabase-vanity-subdomains-activate",
  "supabase-vanity-subdomains-check-availability",
  "supabase-vanity-subdomains-delete",
  "supabase-vanity-subdomains-get",
]);

/**
 * Leaves gated on `--experimental` OR `[experimental.pgdelta] enabled` (default true)
 * in config.toml — the flag is documented but not marked required, since the gate
 * is open unless config sets `enabled = false`.
 */
export const DOCS_EXPERIMENTAL_OPTIONAL: ReadonlySet<string> = new Set([
  "supabase-db-schema-declarative-generate",
  "supabase-db-schema-declarative-sync",
]);

/**
 * Deprecated commands: kept visible in `--help` (with a "(deprecated)"
 * suffix) but excluded from the published reference.
 */
export const DOCS_EXCLUDED: ReadonlySet<string> = new Set([
  "supabase-inspect-db-cache-hit",
  "supabase-inspect-db-index-sizes",
  "supabase-inspect-db-index-usage",
  "supabase-inspect-db-role-configs",
  "supabase-inspect-db-role-connections",
  "supabase-inspect-db-seq-scans",
  "supabase-inspect-db-table-record-counts",
  "supabase-inspect-db-table-sizes",
  "supabase-inspect-db-unused-indexes",
]);

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
