---
id: inspect-db-xid-age
kind: command
category: inspect
title: inspect db xid-age
symbol: supabase inspect db xid-age
summary: Show XID age for user tables
usage: supabase inspect db xid-age [flags]
description: |-
  This command lists user tables sorted by their transaction ID (XID) age, oldest first. PostgreSQL's transaction ID space wraps around at about 2.1 billion transactions. Once a table's XID age passes `autovacuum_freeze_max_age` (200 million by default), autovacuum forces a freeze on it; if the age keeps growing toward the wraparound limit, PostgreSQL stops assigning new transaction IDs to protect the data. `transactions_remaining` is the headroom to a 2 billion threshold, kept below the real limit as a safety margin.

  Tables with an XID age above 1.5 billion transactions (`transactions_remaining` below 500 million) should be treated as urgent: manual `VACUUM FREEZE` or a tuned autovacuum run is needed. The list covers ordinary user tables only: it leaves out materialized views, TOAST tables and Supabase-managed schemas, so it does not show the database-wide age. Check `SELECT age(datfrozenxid) FROM pg_database WHERE datname = current_database()` for that.

  ```
            TABLE          │  XID AGE  │ TRANSACTIONS REMAINING
  ─────────────────────────┼───────────┼────────────────────────
   public.events           │ 800000000 │           1200000000
   public.users            │ 500000000 │           1500000000
   public.sessions         │ 120000000 │           1880000000
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
