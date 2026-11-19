---
id: db-reset
kind: command
category: db
title: db reset
symbol: supabase db reset
summary: Resets a database to current migrations
usage: supabase db reset [flags]
description: |-
  Resets a database to a clean state.

  Requires the local development stack to be started by running `supabase start`.

  Recreates the local Postgres container and applies all local migrations found in `supabase/migrations` directory. If test data is defined in `supabase/seed.sql`, it will be seeded after the migrations are run. Any other data or schema changes made during local development will be discarded.

  Use the `--no-seed` flag to skip seeding entirely. To override `[db.seed].sql_paths` for a single reset, pass one or more `--sql-paths` flags. Each value accepts the same file path or glob pattern syntax as `sql_paths`, relative to the `supabase` directory. Passing `--sql-paths` force-enables seeding for that reset even when `[db.seed].enabled = false`.

  Resets the local database by default. Pass `--remote` to reset the linked project, or `--remote=<ref|branch|url>` to reset another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  When running db reset with `--remote`, a SQL script is executed to identify and drop all user created entities in the remote database. Since Postgres roles are cluster level entities, any custom roles created through the dashboard or `supabase/roles.sql` will not be deleted by remote reset.

  A remote reset asks for one confirmation (default No) after it has worked out what it will do and before anything is dropped. The question lists dropping every user schema, any vault secrets it will upsert, the migrations or schema files it will apply, and the seed files it will run. Declining stops the command without changing the database. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

  If you combine `--sql-paths` with `--remote`, the override seed files are applied to the selected remote database after migrations. Use this only when you intend to seed that remote target.
parameters:
  - name: --last
    location: flag
    type: int
    description: Reset up to the last n migration versions.
    default: "0"
  - name: --no-seed
    location: flag
    type: boolean
    description: Skip running the seed script after reset.
    default: "false"
  - name: --remote
    location: flag
    type: ref|branch|url
    description: "Target a remote database: the linked project, or `--remote=<ref|branch|url>`."
    default: "false"
  - name: --sql-paths
    location: flag
    type: strings
    description: Override db.seed.sql_paths for this reset. May be repeated; each value accepts a SQL file path or glob pattern relative to the supabase directory and force-enables seeding.
    default: "[]"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
  - name: --version
    location: flag
    type: string
    description: Reset up to the specified version.
    default: ""
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
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: "false"
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
examples:
  - id: example-1
    title: Reset the local database without running seed scripts
    lang: sh
    code: supabase db reset --no-seed
  - id: example-2
    title: Reset the local database using seed files relative to supabase/
    lang: sh
    code: supabase db reset --sql-paths seed.sql --sql-paths fixtures/test.sql
---
