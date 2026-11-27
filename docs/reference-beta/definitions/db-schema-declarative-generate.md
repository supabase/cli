---
id: db-schema-declarative-generate
kind: command
category: db
title: db schema declarative generate
symbol: supabase db schema declarative generate
summary: Generate declarative schema from a database
usage: supabase db schema declarative generate [flags]
description: |-
  Generate declarative schema files from a database.

  Exports the schema of a live database into SQL files under the declarative schema directory. This is the entrypoint for bootstrapping declarative mode.

  The database is the local one unless you pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command never asks which database to use. With the local database, `--reset` recreates it from your migrations first. When the destination already holds files, the command asks before overwriting them (pass `--overwrite` or `--yes` to skip the question).

  The bundled pg-delta engine writes one directory per schema at the root of that directory (`supabase/schemas/public/tables/users.sql`, `supabase/schemas/public/schema.sql`), with cluster-level objects that belong to no schema under a reserved `_cluster/` directory (`supabase/schemas/_cluster/roles.sql`). When platform default grants (`anon`/`authenticated`/`service_role`) need an overlay `REVOKE ALL`, the export writes `adp_wipes.sql` after `schema.sql` in that schema — or `_cluster/adp_wipes.sql` for cluster-wide overlays — so a load onto a fresh project keeps privileges that were revoked in the source. A schema literally named `_cluster` or `_custom`, in any casing, has its leading underscore percent-encoded (`%5Fcluster/`) so it can never claim a directory the export owns. Hand-authored SQL that pg-delta does not model belongs in `_custom/`, which the export never writes to and never prunes.

  Emitted SQL uses the same default format as `db pull` (uppercase keywords, indent 2, width 180, column-aligned). Override with `[experimental.pgdelta] format_options`, or set `format_options = "null"` for raw statements.

  Enabled by default. When `[experimental.pgdelta] enabled = false` is set in config, pass the `--experimental` flag to run it.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
parameters:
  - name: --output-dir
    location: flag
    type: string
    description: Write the generated declarative schema to this directory without changing the configured declarative schema path.
    default: ""
  - name: --overwrite
    location: flag
    type: boolean
    description: Overwrite declarative schema files without confirmation.
    default: "false"
  - name: --password
    location: flag
    type: string
    description: Database password for the project selected with --remote. Not used for the local database or a database URL.
    short: -p
    default: ""
  - name: --remote
    location: flag
    type: ref|branch|url
    description: "Target a remote database: the linked project, or `--remote=<ref|branch|url>`."
    default: "false"
  - name: --reset
    location: flag
    type: boolean
    description: Reset local database before generating (local data will be lost).
    default: "false"
  - name: --schema
    location: flag
    type: strings
    description: Comma separated list of schema to include.
    short: -s
    default: "[]"
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: "false"
  - name: --no-cache
    location: flag
    type: boolean
    description: Disable catalog cache and force fresh shadow database setup.
    default: "false"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
  - name: --strict-coverage
    location: flag
    type: boolean
    description: Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.
    default: "false"
  - name: --agent
    location: flag
    type: "[ auto | yes | no ]"
    description: "Override agent detection: yes, no, or auto"
    default: auto
    allowed_values:
      - auto
      - "yes"
      - "no"
  - name: --debug
    location: flag
    type: boolean
    description: output debug logs to stderr
    default: "false"
  - name: --dns-resolver
    location: flag
    type: "[ native | https ]"
    description: lookup domain names using the specified resolver
    default: native
    allowed_values:
      - native
      - https
  - name: --help
    location: flag
    type: boolean
    description: Show help information
    short: -h
    default: "false"
  - name: --network-id
    location: flag
    type: string
    description: use the specified docker network instead of a generated one
    default: ""
  - name: --output
    location: flag
    type: "[ env | pretty | json | toml | yaml ]"
    description: output format of status variables
    short: -o
    default: pretty
    allowed_values:
      - env
      - pretty
      - json
      - toml
      - yaml
  - name: --output-format
    location: flag
    type: "[ text | json | stream-json ]"
    description: "Output format: text, json, or stream-json (NDJSON)"
    default: text
    allowed_values:
      - text
      - json
      - stream-json
  - name: --profile
    location: flag
    type: string
    description: use a specific profile for connecting to Supabase API
    default: supabase
  - name: --workdir
    location: flag
    type: string
    description: path to the directory containing your supabase/ folder; used exactly as given, with no ancestor directory search (defaults to searching upward from the current directory)
    default: ""
  - name: --yes
    location: flag
    type: boolean
    description: answer yes to all prompts; hosted changes only accept this flag or SUPABASE_YES exported in your shell, never supabase/.env or another .env file
    default: "false"
inherits_flags: global-flags
examples: []
---
