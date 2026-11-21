---
id: db-push
kind: command
category: db
title: db push
symbol: supabase db push
summary: Push new migrations to a database
usage: supabase db push [flags]
description: |-
  Pushes all local migrations to a database.

  Pushes to the local database by default. Pass `--remote` to push to the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to push to another project, a branch of the linked project, or a database URL such as a self-hosted database. In a linked checkout, a run without `--remote` prints a hint naming the linked project. The command prints a `Target:` line on stderr naming the database it resolved.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  Before changing a hosted database, the command lists what it will do (migrations, custom roles, seed files and vault secrets) and asks once for confirmation, defaulting to No. Pass `--yes` to confirm without a prompt; JSON output, piped input and agent runs need it. A `SUPABASE_YES` set in `supabase/.env` does not confirm, but one set in your shell does.

  The first time this command is run, a migration history table will be created under `supabase_migrations.schema_migrations`. After successfully applying a migration, a new row will be inserted into the migration history table with timestamp as its unique id. Subsequent pushes will skip migrations that have already been applied.

  If you need to mutate the migration history table, such as deleting existing entries or inserting new entries without actually running the migration, use the `migration repair` command.
parameters:
  - name: --dry-run
    location: flag
    type: boolean
    description: Print the migrations that would be applied, but don't actually apply them.
    default: "false"
  - name: --include-all
    location: flag
    type: boolean
    description: Include all migrations not found in the migration history table.
    default: "false"
  - name: --include-roles
    location: flag
    type: boolean
    description: Include custom roles from supabase/roles.sql.
    default: "false"
  - name: --include-seed
    location: flag
    type: boolean
    description: Include seed data from your config.
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
  - name: --skip-vault
    location: flag
    type: boolean
    description: Skip updating vault secrets from the config file.
    default: "false"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
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
    title: Preview changes to the local database without applying them
    lang: sh
    code: supabase db push --dry-run
---
