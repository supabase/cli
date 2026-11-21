---
id: domains-activate
kind: command
category: domains
title: domains activate
symbol: supabase domains activate
summary: Activate the custom hostname for a project
usage: supabase domains activate [flags]
description: |-
  Activates the custom hostname configuration for a project.

  This reconfigures your Supabase project to respond to requests on your custom hostname.

  After the custom hostname is activated, your project's third-party auth providers will no longer function on the Supabase-provisioned subdomain. Please refer to [Prepare to activate your domain](/docs/guides/platform/custom-domains#prepare-to-activate-your-domain) section in our documentation to learn more about the steps you need to follow.

  Asks for confirmation before activating, with a default of No. Pass `--yes` (or set `SUPABASE_YES` in the shell) to run without a prompt, which JSON output and non-interactive runs require.
parameters:
  - name: --remote
    location: flag
    type: ref|branch
    description: "Target another project: `--remote=<ref|branch>`. Defaults to the linked project."
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
    title: Activate the custom hostname for a project
    lang: sh
    code: supabase domains activate --remote=abcdefghijklmnopqrst
---
