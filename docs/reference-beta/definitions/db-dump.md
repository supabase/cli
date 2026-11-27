---
id: db-dump
kind: command
category: db
title: db dump
symbol: supabase db dump
summary: Dumps data or schemas from a database
usage: supabase db dump [flags]
description: |-
  Dumps contents from a database.

  Dumps the local database by default. Pass `--remote` to dump the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to dump another project, a branch of the linked project, or a database URL such as a self-hosted database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  Runs `pg_dump` in a container with additional flags to exclude Supabase managed schemas. The ignored schemas include auth, storage, and those created by extensions.

  The default dump does not contain any data or custom roles.

  ### Note on Privilege Migration

  When restoring to a new project, tables, functions, and sequences get the default privileges of the target database, which can grant more than your dump. To preserve specific privileges from your dump, revoke defaults before restoring:

  ```sql
  -- Run BEFORE restoring your schema, and again before any later restore into the same database
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ```
parameters:
  - name: --data-only
    location: flag
    type: boolean
    description: Dumps only data records.
    default: "false"
  - name: --dry-run
    location: flag
    type: boolean
    description: Prints the pg_dump script that would be executed.
    default: "false"
  - name: --exclude
    location: flag
    type: strings
    description: List of schema.tables to exclude from data-only dump.
    short: -x
    default: "[]"
  - name: --file
    location: flag
    type: string
    description: File path to save the dumped contents.
    short: -f
    default: ""
  - name: --keep-comments
    location: flag
    type: boolean
    description: Keeps commented lines from pg_dump output.
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
  - name: --role-only
    location: flag
    type: boolean
    description: Dumps only cluster roles.
    default: "false"
  - name: --schema
    location: flag
    type: strings
    description: Comma separated list of schema to include.
    short: -s
    default: "[]"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
  - name: --use-copy
    location: flag
    type: boolean
    description: Use copy statements in place of inserts.
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
    title: Dump data from the local database without schema definitions
    lang: sh
    code: supabase db dump --data-only
  - id: example-2
    title: Dump custom roles from the local database
    lang: sh
    code: supabase db dump --role-only
---
