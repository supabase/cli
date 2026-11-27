---
id: migration-repair
kind: command
category: migration
title: migration repair
symbol: supabase migration repair
summary: Repair the migration history table
usage: supabase migration repair [version] ... [flags]
description: |-
  Repairs the migration history table.

  By default, it repairs your local database. Pass `--remote` to repair the linked project, which requires running `supabase link`. Pass `--remote=<ref|branch|url>` to repair another project, a branch of the linked project, or a specific database. Repairing a hosted database asks for confirmation before it changes anything (the default answer is No); pass `--yes` to confirm in scripts and other non-interactive runs.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  If your local and remote migration history goes out of sync, you can repair the remote history by marking specific migrations as `--status applied` or `--status reverted`. Marking as `reverted` will delete an existing record from the migration history table while marking as `applied` will insert a new record.

  For example, your migration history may look like the table below, with missing entries in either local or remote.

  ```bash
  $ supabase migration list --remote
  Target: project My Project (abcdefghijklmnopqrst) · production
          LOCAL      │     REMOTE     │     TIME (UTC)
    ─────────────────┼────────────────┼──────────────────────
                     │ 20230103054303 │ 2023-01-03 05:43:03
     20230103054315  │                │ 2023-01-03 05:43:15
  ```

  To reset your migration history to a clean state, first delete your local migration file.

  ```bash
  $ rm supabase/migrations/20230103054315_remote_commit.sql

  $ supabase migration list --remote
  Target: project My Project (abcdefghijklmnopqrst) · production
          LOCAL      │     REMOTE     │     TIME (UTC)
    ─────────────────┼────────────────┼──────────────────────
                     │ 20230103054303 │ 2023-01-03 05:43:03
  ```

  Then mark the remote migration `20230103054303` as reverted.

  ```bash
  $ supabase migration repair 20230103054303 --status reverted --remote
  Target: project My Project (abcdefghijklmnopqrst) · production
   • 20230103054303
  ◇  Mark 1 migration as reverted on project My Project (abcdefghijklmnopqrst) · production?
  │  Yes
  Repaired migration history: [20230103054303] => reverted
  Finished supabase migration repair.

  $ supabase migration list --remote
  Target: project My Project (abcdefghijklmnopqrst) · production
          LOCAL      │     REMOTE     │     TIME (UTC)
    ─────────────────┼────────────────┼──────────────────────
  ```

  Now you can run `db pull` again to dump the remote schema as a local migration file.

  ```bash
  $ supabase db pull --remote
  Target: project My Project (abcdefghijklmnopqrst) · production
  Write 1 migration file to supabase/migrations.
  Record them as applied in the remote migration history.
  ◇  Update the remote migration history table on project My Project (abcdefghijklmnopqrst) · production?
  │  Yes
  Schema written to supabase/migrations/20240414044403_remote_schema.sql
  Finished supabase db pull.

  $ supabase migration list --remote
  Target: project My Project (abcdefghijklmnopqrst) · production
          LOCAL      │     REMOTE     │     TIME (UTC)
    ─────────────────┼────────────────┼──────────────────────
      20240414044403 │ 20240414044403 │ 2024-04-14 04:44:03
  ```
parameters:
  - name: version
    location: positional
    required: false
    variadic: true
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
  - name: --status
    location: flag
    type: "[ applied | reverted ]"
    description: Version status to update.
    default: ""
    required: true
    allowed_values:
      - applied
      - reverted
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
examples: []
---
