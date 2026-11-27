---
id: inspect-db-vacuum-stats
kind: command
category: inspect
title: inspect db vacuum-stats
symbol: supabase inspect db vacuum-stats
summary: Show vacuum stats
usage: supabase inspect db vacuum-stats [flags]
description: |-
  This shows you stats about the vacuum activities for each table. Due to Postgres' [MVCC](https://www.postgresql.org/docs/current/mvcc.html) when data is updated or deleted new rows are created and old rows are made invisible and marked as "dead tuples". Usually the [autovaccum](https://supabase.com/docs/guides/platform/database-size#vacuum-operations) process will aysnchronously clean the dead tuples.

  The command lists when the last vacuum and last auto vacuum took place, the row count on the table as well as the count of dead rows and whether autovacuum is expected to run or not. If the number of dead rows is much higher than the row count, or if an autovacuum is expected but has not been performed for some time, this can indicate that autovacuum is not able to keep up and that your vacuum settings need to be tweaked or that you require more compute or disk IOPS to allow autovaccum to complete.

  ```
          SCHEMA        │              TABLE               │ LAST VACUUM │ LAST AUTO VACUUM │      ROW COUNT       │ DEAD ROW COUNT │ EXPECT AUTOVACUUM?
  ──────────────────────┼──────────────────────────────────┼─────────────┼──────────────────┼──────────────────────┼────────────────┼─────────────────────
   auth                 │ users                            │             │ 2023-06-26 12:34 │               18,030 │              0 │ no
   public               │ profiles                         │             │ 2023-06-26 23:45 │               13,420 │             28 │ no
   public               │ logs                             │             │ 2023-06-26 01:23 │            1,313,033 │      3,318,228 │ yes
   storage              │ objects                          │             │                  │             No stats │              0 │ no
   storage              │ buckets                          │             │                  │             No stats │              0 │ no
   supabase_migrations  │ schema_migrations                │             │                  │             No stats │              0 │ no

  ```
parameters:
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
