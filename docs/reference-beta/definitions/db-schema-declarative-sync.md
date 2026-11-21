---
id: db-schema-declarative-sync
kind: command
category: db
title: db schema declarative sync
symbol: supabase db schema declarative sync
summary: Generate a new migration from declarative schema
usage: supabase db schema declarative sync [flags]
description: |-
  Generate a new migration by diffing your declarative schema files against the current migration state.

  When no declarative schema exists yet, the command offers to run `generate` first, exporting from the local database. To start from a linked project or a database URL, run `generate --remote` or `generate --remote=<url>` yourself first. After computing the diff, you can optionally name the migration and apply it to the local database.

  Enabled by default. When `[experimental.pgdelta] enabled = false` is set in config, pass the `--experimental` flag to run it.
parameters:
  - name: --apply
    location: flag
    type: boolean
    description: Apply the generated migration to the local database without prompting.
    default: "false"
  - name: --file
    location: flag
    type: string
    description: Saves schema diff to a new migration file.
    short: -f
    default: declarative_sync
  - name: --name
    location: flag
    type: string
    description: Name for the generated migration file.
    default: ""
  - name: --no-apply
    location: flag
    type: boolean
    description: Generate the migration file without prompting or applying it to the local database.
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
