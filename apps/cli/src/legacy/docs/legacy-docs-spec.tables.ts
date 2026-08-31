import type { LegacyDocsFlag } from "./legacy-docs-spec.ts";

/**
 * Static data for the docs spec generator — information the Effect command
 * tree cannot express structurally:
 *
 * - Docs-site section tags: envelope compatibility only (the site's
 *   navigation comes from `common-cli-sections.json`, not from tags).
 * - Experimental leaves: each appends the root `--experimental` flag with
 *   `required: true` to its flag list.
 * - Deprecated commands: visible in `--help` (with a "(deprecated)" suffix)
 *   but excluded from the published reference.
 * - Flag defaults: `Flag.withDefault` captures the value in a closure
 *   (`Param.ts`: `map(optional(self), Option.getOrElse(...))`), so defaults
 *   that differ from the type's zero value are recorded here, keyed
 *   `"<doc id> <flag id>"`.
 *
 * The values were frozen from the retired Go generator's output when the
 * pipeline was re-pointed at the TS tree, and every entry was verified
 * against it while both generators coexisted.
 * Flag display types derive purely from the Effect tree — Go-only scalar
 * typing (uint/duration/time) was deliberately not ported, so the reference
 * shows the TS types `--help` shows.
 * `legacyBuildDocsSpec` validates every key here against the walked tree and
 * fails the build on stale entries.
 */

export interface LegacyDocsInfoTag {
  readonly id: string;
  readonly title: string;
}

export const LEGACY_DOCS_INFO_TAGS: ReadonlyArray<LegacyDocsInfoTag> = [
  { id: "quick-start", title: "Quick Start" },
  { id: "local-dev", title: "Local Development" },
  { id: "management-api", title: "Management APIs" },
  { id: "other-commands", title: "Additional Commands" },
];

/** Docs-site section tag per top-level command. */
export const LEGACY_DOCS_TAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "supabase-bootstrap": ["quick-start"],
  "supabase-backups": ["management-api"],
  "supabase-branches": ["management-api"],
  "supabase-completion": ["other-commands"],
  "supabase-config": ["management-api"],
  "supabase-db": ["local-dev"],
  "supabase-domains": ["management-api"],
  "supabase-encryption": ["management-api"],
  "supabase-functions": ["management-api"],
  "supabase-gen": ["local-dev"],
  "supabase-init": ["local-dev"],
  "supabase-inspect": ["local-dev"],
  "supabase-issue": ["other-commands"],
  "supabase-link": ["local-dev"],
  "supabase-login": ["local-dev"],
  "supabase-logout": ["local-dev"],
  "supabase-migration": ["local-dev"],
  "supabase-network-bans": ["management-api"],
  "supabase-network-restrictions": ["management-api"],
  "supabase-orgs": ["management-api"],
  "supabase-postgres-config": ["management-api"],
  "supabase-projects": ["management-api"],
  "supabase-secrets": ["management-api"],
  "supabase-seed": ["local-dev"],
  "supabase-services": ["local-dev"],
  "supabase-workers": ["management-api"],
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
};

/** Leaves that require `--experimental`. */
export const LEGACY_DOCS_EXPERIMENTAL: ReadonlySet<string> = new Set([
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
 * Leaves gated on `--experimental` OR `[experimental.pgdelta] enabled = true`
 * in config.toml — the flag is documented but not marked required, since the
 * config path also passes the gate.
 */
export const LEGACY_DOCS_EXPERIMENTAL_OPTIONAL: ReadonlySet<string> = new Set([
  "supabase-db-schema-declarative-generate",
  "supabase-db-schema-declarative-sync",
]);

/**
 * Deprecated commands: kept visible in `--help` (with a "(deprecated)"
 * suffix) but excluded from the published reference.
 */
export const LEGACY_DOCS_EXCLUDED: ReadonlySet<string> = new Set([
  "supabase-gen-keys",
  "supabase-inspect-db-cache-hit",
  "supabase-inspect-db-index-sizes",
  "supabase-inspect-db-index-usage",
  "supabase-inspect-db-role-configs",
  "supabase-inspect-db-role-connections",
  "supabase-inspect-db-seq-scans",
  "supabase-inspect-db-table-index-sizes",
  "supabase-inspect-db-table-record-counts",
  "supabase-inspect-db-table-sizes",
  "supabase-inspect-db-total-index-size",
  "supabase-inspect-db-total-table-sizes",
  "supabase-inspect-db-unused-indexes",
]);

/**
 * Flag defaults that differ from the primitive type's zero value, keyed
 * `"<doc id> <flag id>"` (root global flags use doc id `supabase`). TS-only
 * flags add entries by hand.
 */
export const LEGACY_DOCS_DEFAULT_OVERRIDES: Readonly<Record<string, string>> = {
  "supabase agent": "auto",
  "supabase dns-resolver": "native",
  "supabase output": "pretty",
  "supabase output-format": "text",
  "supabase profile": "supabase",
  "supabase-db-advisors fail-on": "none",
  "supabase-db-advisors level": "warn",
  "supabase-db-advisors local": "true",
  "supabase-db-advisors type": "all",
  "supabase-db-diff local": "true",
  "supabase-db-dump linked": "true",
  "supabase-db-lint fail-on": "none",
  "supabase-db-lint level": "warning",
  "supabase-db-lint local": "true",
  "supabase-db-pull diff-engine": "pg-delta",
  "supabase-db-pull linked": "true",
  "supabase-db-push linked": "true",
  "supabase-db-query local": "true",
  "supabase-db-reset local": "true",
  "supabase-db-schema-declarative-sync file": "declarative_sync",
  "supabase-functions-deploy jobs": "1",
  "supabase-functions-new auth": "apikey",
  "supabase-gen-bearer-jwt payload": "{}",
  "supabase-gen-bearer-jwt sub": "anonymous",
  "supabase-gen-bearer-jwt valid-for": "30m0s",
  "supabase-gen-signing-key algorithm": "ES256",
  "supabase-gen-types lang": "typescript",
  "supabase-gen-types query-timeout": "15s",
  "supabase-gen-types swift-access-control": "internal",
  "supabase-inspect-db-bloat linked": "true",
  "supabase-inspect-db-blocking linked": "true",
  "supabase-inspect-db-calls linked": "true",
  "supabase-inspect-db-db-stats linked": "true",
  "supabase-inspect-db-index-stats linked": "true",
  "supabase-inspect-db-locks linked": "true",
  "supabase-inspect-db-long-running-queries linked": "true",
  "supabase-inspect-db-outliers linked": "true",
  "supabase-inspect-db-replication-slots linked": "true",
  "supabase-inspect-db-role-stats linked": "true",
  "supabase-inspect-db-table-stats linked": "true",
  "supabase-inspect-db-traffic-profile linked": "true",
  "supabase-inspect-db-vacuum-stats linked": "true",
  "supabase-inspect-report linked": "true",
  "supabase-inspect-report output-dir": ".",
  "supabase-login name": "built-in token name generator",
  "supabase-migration-down last": "1",
  "supabase-migration-down local": "true",
  "supabase-migration-fetch linked": "true",
  "supabase-migration-list linked": "true",
  "supabase-migration-repair linked": "true",
  "supabase-migration-squash local": "true",
  "supabase-migration-up local": "true",
  "supabase-seed-buckets local": "true",
  "supabase-storage-cp cache-control": "max-age=3600",
  "supabase-storage-cp content-type": "auto-detect",
  "supabase-storage-cp jobs": "1",
  "supabase-storage-cp linked": "true",
  "supabase-storage-ls linked": "true",
  "supabase-storage-mv linked": "true",
  "supabase-storage-rm linked": "true",
  "supabase-test-db local": "true",
  "supabase-test-new template": "pgtap",
  "supabase-workers-push instances": "1",
};

/**
 * Flag docs injected into specific commands beyond what their Effect config
 * declares, keyed by doc id. `db query` reuses the global `-o, --output`
 * choice at parse time (which documents only the globally valid formats), so
 * its own page documents the query-specific formats here.
 */
export const LEGACY_DOCS_EXTRA_FLAGS: Readonly<Record<string, ReadonlyArray<LegacyDocsFlag>>> = {
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
 * Documented accepted values where the Effect choice union is wider than the
 * globally valid set, keyed `"<doc id> <flag id>"`. The root `-o, --output`
 * union includes `table`/`csv` only because `db query` reuses the global
 * flag; everywhere else the valid formats are the five below.
 */
export const LEGACY_DOCS_CHOICE_OVERRIDES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "supabase output": ["env", "pretty", "json", "toml", "yaml"],
};

/**
 * Flags excluded from the published reference, keyed `"<doc id> <flag id>"`.
 * Cobra hid deprecated flags from help and docs; the Effect port keeps
 * `--include-raw-output` parse-visible for compatibility (see
 * `commands/domains/SIDE_EFFECTS.md`), so the docs exclusion is restored
 * here. Validated at build time like the other tables.
 */
export const LEGACY_DOCS_EXCLUDED_FLAGS: ReadonlySet<string> = new Set([
  "supabase-domains-activate include-raw-output",
  "supabase-domains-create include-raw-output",
  "supabase-domains-delete include-raw-output",
  "supabase-domains-get include-raw-output",
  "supabase-domains-reverify include-raw-output",
]);

/**
 * Usage argument overrides, keyed by doc id — for commands whose published
 * argument rendering cannot be derived from the Effect tree. Both were
 * hand-written cobra `Use` strings: the parser accepts zero occurrences
 * (`secrets set --env-file` passes no positionals; `storage rm` validates in
 * the handler), but the documented shape is required.
 */
export const LEGACY_DOCS_ARG_OVERRIDES: Readonly<Record<string, string>> = {
  "supabase-secrets-set": "<NAME=VALUE> ...",
  "supabase-storage-rm": "<file> ...",
};

/**
 * Flags rendered with a Required badge on the docs site, keyed
 * `"<doc id> <flag id>"`. Effect optionality cannot express this — several
 * of these TS flags are intentionally `Flag.optional` at parse time for
 * validation-ordering reasons unrelated to required-ness.
 */
export const LEGACY_DOCS_REQUIRED: ReadonlySet<string> = new Set([
  "supabase-domains-create custom-hostname",
  "supabase-gen-bearer-jwt role",
  "supabase-migration-repair status",
  "supabase-sso-add type",
  "supabase-vanity-subdomains-activate desired-subdomain",
  "supabase-vanity-subdomains-check-availability desired-subdomain",
]);

export const LEGACY_DOCS_INFO_DESCRIPTION =
  "Supabase CLI provides you with tools to develop your application locally, and deploy your application to the Supabase platform.";
