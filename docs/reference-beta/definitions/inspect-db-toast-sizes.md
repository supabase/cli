---
id: inspect-db-toast-sizes
kind: command
category: inspect
title: inspect db toast-sizes
symbol: supabase inspect db toast-sizes
summary: Show TOAST table sizes and dead chunk counts
usage: supabase inspect db toast-sizes [flags]
description: |-
  This command displays TOAST table sizes and dead chunk counts for every ordinary user table that has a TOAST relation (materialized views and partitioned parents are not listed). When a row exceeds ~2 kB, Postgres compresses and/or moves its largest variable-length values (TEXT, JSONB, bytea) out-of-line into a companion TOAST table. TOAST Size includes the TOAST index; Total Size also includes the table's own indexes. Autovacuum runs on the TOAST table independently from the main heap, so it can accumulate dead chunks even when the parent table looks healthy by its own dead-tuple count.

  A table that appears fine by `vacuum-stats` or `bloat` alone can still have significant TOAST bloat that wastes disk space and slows reads. High `TOAST Dead %` values indicate that autovacuum is not keeping up with the TOAST table and a manual `VACUUM` may be needed.

  ```
           TABLE          │ TOTAL SIZE │ HEAP SIZE │ TOAST SIZE │ TOAST LIVE CHUNKS │ TOAST DEAD CHUNKS │ TOAST DEAD % │  LAST AUTOVACUUM   │ LAST VACUUM
  ────────────────────────┼────────────┼───────────┼────────────┼───────────────────┼───────────────────┼──────────────┼────────────────────┼─────────────
   public.documents       │ 4350 MB    │ 800 MB    │ 3400 MB    │            250000 │             18000 │          6.7 │ 2024-03-01 04:12   │
   public.media_assets    │ 905 MB     │ 120 MB    │ 770 MB     │             80000 │               200 │          0.2 │ 2024-03-02 01:45   │
   public.messages        │ 365 MB     │ 280 MB    │ 60 MB      │             95000 │                 0 │          0.0 │ 2024-03-02 03:10   │
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
