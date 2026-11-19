---
id: config-push
kind: command
category: config
title: config push
symbol: supabase config push
summary: Push local config to linked project
usage: supabase config push [flags]
description: |-
  Updates the configurations of a linked Supabase project with the local `supabase/config.toml` file.

  This command allows you to manage project configuration as code by defining settings locally and then pushing them to your remote project.

  Pass `--remote=<ref|branch>` to push to a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target. `--project-ref` still works in v3 but is deprecated and removed in v4; use `--remote`.

  Before anything is pushed, the command prints the `Target:` line for the project or branch it resolved (name, ref, and for a branch its parent project), then shows the exact diff for every resource that will change. It then asks once — a single question covering every changed resource, with a default answer of no — and sends nothing until you confirm. If a change enables a paid add-on, its price is printed before the question.

  A push with nothing to change never asks. Declining fails the command and writes nothing. Piped answers are never read, so a script, a JSON run (`-o json`, `--output-format json`) or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. With `--yes` the command echoes `Confirmed by --yes: …` to stderr and pushes.

  In `json` output the result carries a `target` object with the resolved identity (`kind`, `project_ref`, `project_name`, `environment`, and `parent_project_ref` for a branch) next to the push summary.
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
    title: Push local config to the linked project
    lang: sh
    code: supabase config push
  - id: example-2
    title: Push local config to a specific project
    lang: sh
    code: supabase config push --remote=abcdefghijklmnopqrst
  - id: example-3
    title: Push local config to the 'staging' branch
    lang: sh
    code: supabase config push --remote=staging
---
