---
id: migration-squash
kind: command
category: migration
title: migration squash
symbol: supabase migration squash
summary: Squash migrations to a single file
usage: supabase migration squash [flags]
description: |-
  Squashes local schema migrations to a single migration file.

  The squashed migration is equivalent to a schema only dump of the local database after applying existing migration files. This is especially useful when you want to remove repeated modifications of the same schema from your migration history.

  However, one limitation is that data manipulation statements, such as insert, update, or delete, are omitted from the squashed migration. You will have to add them back manually in a new migration file. This includes cron jobs, storage buckets, and any encrypted secrets in vault.

  By default, the latest `<timestamp>_<name>.sql` file will be updated to contain the squashed migration. You can override the target version using the `--version <timestamp>` flag.

  If your `supabase/migrations` directory is empty, running `supabase squash` will do nothing.

  Squashing rewrites your local migration files. When the target is a hosted database (`--remote` or `--remote=<ref|branch|url>`), it also resets the remote migration history table to the squashed migration. That asks for confirmation before any file is changed (the default answer is No); pass `--yes` to confirm in scripts and other non-interactive runs. With the default local target it only squashes the files and suggests running `supabase migration repair --status applied --remote` for the remote history.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
parameters:
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
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
  - name: --version
    location: flag
    type: string
    description: Squash up to the specified version.
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
    title: Squash local migrations up to the specified version
    lang: sh
    code: supabase migration squash --version 20240414044403
---
