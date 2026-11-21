---
id: completion-zsh
kind: command
category: completion
title: completion zsh
symbol: supabase completion zsh
summary: Generate the autocompletion script for zsh
usage: supabase completion zsh [flags]
description: |-
  Generate the autocompletion script for the zsh shell.

  If shell completion is not already enabled in your environment you will need
  to enable it.  You can execute the following once:

      echo "autoload -U compinit; compinit" >> ~/.zshrc

  To load completions in your current shell session:

      source <(supabase completion zsh)

  To load completions for every new session, execute once:

  Linux:

      supabase completion zsh > "${fpath[1]}/_supabase"

  macOS:

      supabase completion zsh > $(brew --prefix)/share/zsh/site-functions/_supabase

  You will need to start a new shell for this setup to take effect.
parameters:
  - name: --no-descriptions
    location: flag
    type: boolean
    description: disable completion descriptions
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
examples: []
---
