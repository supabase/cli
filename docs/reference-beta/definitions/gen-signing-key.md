---
id: gen-signing-key
kind: command
category: gen
title: gen signing-key
symbol: supabase gen signing-key
summary: Generate a JWT signing key
usage: supabase gen signing-key [flags]
description: |-
  Securely generate a private JWT signing key for use in the CLI or to import in the dashboard.

  Supported algorithms:

  ES256 - ECDSA with P-256 curve and SHA-256 (recommended)

  RS256 - RSA with SHA-256
parameters:
  - name: --algorithm
    location: flag
    type: "[ ES256 | RS256 ]"
    description: Algorithm for signing key generation.
    default: ES256
    allowed_values:
      - ES256
      - RS256
  - name: --append
    location: flag
    type: boolean
    description: Append new key to existing keys file instead of overwriting.
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
    title: Generate an ES256 signing key and print it to stdout
    lang: sh
    code: supabase gen signing-key
  - id: example-2
    title: Generate an RSA signing key
    lang: sh
    code: supabase gen signing-key --algorithm RS256
  - id: example-3
    title: Append a new key to the configured signing key file
    lang: sh
    code: supabase gen signing-key --append
---
