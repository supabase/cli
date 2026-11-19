---
id: secrets
kind: command
category: secrets
title: secrets
symbol: supabase secrets
summary: Manage Supabase secrets
usage: supabase secrets
description: |-
  Provides tools for managing environment variables and secrets for your Supabase project.

  This command group allows you to set, unset, and list secrets that are securely stored and made available to Edge Functions as environment variables.

  Secrets management through the CLI is useful for:

  - Setting environment-specific configuration
  - Managing sensitive credentials securely

  Secrets can be set individually or loaded from .env files for convenience.

  `secrets set` and `secrets unset` print the `Target:` line, then ask for confirmation before changing anything; the default answer is no, and the question lists the secret names (never their values). Piped answers are never read, so scripts, JSON runs and agents must pass `--yes` or set `SUPABASE_YES` in the shell (a `SUPABASE_YES` in `supabase/.env` does not count). `secrets unset --dry-run` and `secrets list` only read and never ask.
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
