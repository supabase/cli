---
id: projects-api-keys
kind: command
category: Projects
title: projects api-keys
symbol: supabase projects api-keys
summary: List API keys for a project
usage: supabase projects api-keys [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --reveal
    location: flag
    type: boolean
    description: Reveal secret API keys in full, such as `sb_secret_...`.
    default: false
examples:
  - id: example-1
    title: List all API keys for a project
    lang: sh
    code: supabase projects api-keys --remote=abcdefghijklmnopqrst
  - id: example-2
    title: List API keys with the secret keys revealed in full
    lang: sh
    code: supabase projects api-keys --reveal --output json
---

Show the API keys of a project. Secret keys are masked unless you pass `--reveal`.
