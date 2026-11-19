---
id: inspect-db-traffic-profile
kind: command
category: inspect
title: inspect db traffic-profile
symbol: supabase inspect db traffic-profile
summary: Show traffic profile
usage: supabase inspect db traffic-profile [flags]
description: |-
  This command analyzes table I/O patterns to show read/write activity ratios based on block-level operations. It combines data from PostgreSQL's `pg_stat_user_tables` (for tuple operations) and `pg_statio_user_tables` (for block I/O) to categorize each table's workload profile.

  The command classifies tables into categories:

  - **Read-Heavy** - Read operations are more than 5x write operations (e.g., 1:10, 1:50)
  - **Write-Heavy** - Write operations are more than 20% of read operations (e.g., 1:2, 1:4, 2:1, 10:1)
  - **Balanced** - Mixed workload where writes are between 20% and 500% of reads
  - **Read-Only** - Only read operations detected
  - **Write-Only** - Only write operations detected

  ```
  SCHEMA │ TABLE        │ BLOCKS READ │ WRITE TUPLES │ BLOCKS WRITE │ ACTIVITY RATIO
  ───────┼──────────────┼─────────────┼──────────────┼──────────────┼────────────────────
  public │ user_events  │     450,234 │     9,004,680│       23,450 │ 20:1 (Write-Heavy)
  public │ users        │      89,203 │        12,451│        1,203 │ 7.2:1 (Read-Heavy)
  public │ sessions     │      15,402 │        14,823│        2,341 │ ≈1:1 (Balanced)
  public │ cache_data   │     123,456 │             0│            0 │ Read-Only
  auth   │ audit_logs   │           0 │        98,234│       12,341 │ Write-Only
  ```

  **Note:** This command only displays tables that have had both read and write activity. Tables with no I/O operations are not shown. The classification ratio threshold (default: 5:1) determines when a table is considered "heavy" in one direction versus balanced.
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
