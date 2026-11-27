---
id: db-query
kind: command
category: db
title: db query
symbol: supabase db query
summary: Execute a SQL query against the database
usage: supabase db query [sql] [flags]
description: |-
  Execute a SQL query against a database.

  Runs against the local database by default. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  The command cannot tell a read from a write, so a hosted database (the linked project or a remote database URL) asks for one confirmation (default No) before the statement is sent. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

  Pass `--read-only` to run a statement that must not change anything. It skips the confirmation on a hosted database. Before the statement is sent or any question is asked, every statement must start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` or a parenthesised query (after whitespace and comments). Any other statement (`COMMIT`, `SET`, `CALL`, `DO`, `COPY`, `LOCK` and so on), input that ends inside a comment, quote or dollar quote, and input that contains a `BEGIN ATOMIC` function body is rejected. The words `begin atomic` inside a string, quoted identifier, dollar quote or comment, as in `select 'begin atomic'`, are not. Drop `--read-only` to run one of these.

  The local database or a database URL then runs the statement in a read-only transaction that is always rolled back, with a 5 second `lock_timeout` so the read cannot wait on heavy locks; Postgres rejects writes inside it. A linked project runs it through the Management API's `read_only` mode, and the API enforces it.

  `--read-only` does not stop a read statement from calling a function that has side effects, such as `pg_terminate_backend` or `dblink_exec`; those still run.

  When used by an AI coding agent (auto-detected or via --agent=yes), the default
  output format is JSON with an untrusted data warning envelope. When used by a
  human (--agent=no or no agent detected), the default output format is table
  without the envelope.
parameters:
  - name: sql
    location: positional
    required: false
  - name: --file
    location: flag
    type: string
    description: Path to a SQL file to execute.
    short: -f
    default: ""
  - name: --output
    location: flag
    type: "[ json | table | csv ]"
    description: "Output format: table, json, or csv."
    short: -o
    default: json
    allowed_values:
      - json
      - table
      - csv
  - name: --read-only
    location: flag
    type: boolean
    description: Runs the statement in a read-only transaction; a hosted target needs no confirmation.
    default: "false"
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
