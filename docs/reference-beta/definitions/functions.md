---
id: functions
kind: command
category: functions
title: functions
symbol: supabase functions
summary: Manage Supabase Edge functions
usage: supabase functions
description: |-
  Manage Supabase Edge Functions.

  Supabase Edge Functions are server-less functions that run close to your users.

  Edge Functions allow you to execute custom server-side code without deploying or scaling a traditional server. They're ideal for handling webhooks, custom API endpoints, data validation, and serving personalized content.

  Edge Functions are written in TypeScript and run on Deno compatible edge runtime, which is a secure runtime with no package management needed, fast cold starts, and built-in security.

  Commands that change the hosted project — `functions deploy` (including `--prune`) and `functions delete` — print the `Target:` line, then ask for confirmation before changing anything; the default answer is no. `functions deploy` asks one question covering every function it will deploy and every function `--prune` will delete. Piped answers are never read, so scripts, JSON runs and agents must pass `--yes` or set `SUPABASE_YES` in the shell (a `SUPABASE_YES` in `supabase/.env` does not count). `functions list` and `functions download` only read and never ask.
parameters:
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
