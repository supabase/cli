---
id: login
kind: command
category: login
title: login
symbol: supabase login
summary: Authenticate using an access token
usage: supabase login [flags]
description: |-
  Connect the Supabase CLI to your Supabase account by logging in with your [personal access token](https://supabase.com/dashboard/account/tokens).

  Your access token is stored securely in native credentials storage (the operating system keyring). If native credentials storage is unavailable, it will be written to a plain text file at `<SUPABASE_HOME or ~/.supabase>/access-token`.

  > If this behavior is not desired, such as in a CI environment, you may skip login by specifying the `SUPABASE_ACCESS_TOKEN` environment variable in other commands.

  The Supabase CLI uses the stored token to access Management APIs for projects, functions, secrets, etc.

  > The Management API client retries retryable failures up to 5 times by default. Set `SUPABASE_API_MAX_RETRIES` to change that. It counts retries after the first attempt, so `0` sends each request once.
parameters:
  - name: --name
    location: flag
    type: string
    description: Name that will be used to store token in your settings.
    default: built-in token name generator
  - name: --no-browser
    location: flag
    type: boolean
    description: Do not open browser automatically.
    default: "false"
  - name: --token
    location: flag
    type: string
    description: Use provided token instead of automatic login flow.
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
