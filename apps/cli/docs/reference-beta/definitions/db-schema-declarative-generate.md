---
id: db-schema-declarative-generate
kind: command
category: Database
title: db schema declarative generate
symbol: supabase db schema declarative generate
summary: Generate declarative schema from a database
usage: supabase db schema declarative generate [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --output-dir
    location: flag
    type: string
    description: Write the generated declarative schema to this directory instead of the configured declarative schema path.
  - name: --overwrite
    location: flag
    type: boolean
    description: Overwrite existing declarative schema files without asking.
    default: false
  - name: --password
    location: flag
    type: string
    description: Database password for the project selected with --remote; ignored for the local database and database URLs.
    short: -p
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
  - name: --reset
    location: flag
    type: boolean
    description: Reset the local database from your migrations before generating, which discards local data.
    default: false
  - name: --schema
    location: flag
    type: strings
    description: Comma-separated list of schemas to include.
    short: -s
    variadic: true
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: false
  - name: --no-cache
    location: flag
    type: boolean
    description: Disable the catalog cache and force a fresh shadow database setup.
    default: false
  - name: --strict-coverage
    location: flag
    type: boolean
    description: Fail when pg-delta finds schema objects it cannot manage, instead of leaving them unmanaged.
    default: false
examples:
  - id: example-1
    title: Export the local database as declarative schema files
    lang: sh
    code: supabase db schema declarative generate
  - id: example-2
    title: Replace the declarative files with the schema of the linked project
    lang: sh
    code: supabase db schema declarative generate --remote --overwrite
---

Export the schema of a live database as SQL files in the declarative schema directory. This is the entry point for bootstrapping declarative mode.

The database is the local one unless you pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command never asks which database to use. With the local database, `--reset` recreates it from your migrations first.

When the destination already holds files, the command asks before overwriting them. Pass `--overwrite` or `--yes` to skip the question.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

## Output layout

The bundled pg-delta engine writes one directory per schema at the root of the declarative directory, such as `supabase/schemas/public/tables/users.sql` and `supabase/schemas/public/schema.sql`. Cluster-level objects that belong to no schema go under a reserved `_cluster/` directory, such as `supabase/schemas/_cluster/roles.sql`.

When platform default grants (`anon`, `authenticated`, `service_role`) need an overlay `REVOKE ALL`, the export writes `adp_wipes.sql` after `schema.sql` in that schema, or `_cluster/adp_wipes.sql` for cluster-wide overlays. This keeps privileges that were revoked in the source when you load the files onto a fresh project.

A schema named `_cluster` or `_custom`, in any casing, has its leading underscore percent-encoded (`%5Fcluster/`) so it never claims a directory the export owns. Put hand-written SQL that pg-delta does not model in `_custom/`, which the export never writes to or prunes.

## Formatting

Emitted SQL uses the same default format as `db pull`: uppercase keywords, indent 2, width 180, and column alignment. Override it with `[experimental.pgdelta] format_options`, or set `format_options = "null"` for raw statements.

This command is enabled by default. When `[experimental.pgdelta] enabled = false` is set in config, pass `--experimental` to run it.
