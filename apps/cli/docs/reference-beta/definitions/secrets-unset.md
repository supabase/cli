---
id: secrets-unset
kind: command
category: Secrets
title: secrets unset
symbol: supabase secrets unset
summary: Unset secrets on the linked project
usage: supabase secrets unset [NAME] ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: NAME
    location: positional
    required: false
    variadic: true
  - name: --all
    location: flag
    type: boolean
    description: Unset every secret except those prefixed with SUPABASE_; required when no names are given.
    default: false
  - name: --dry-run
    location: flag
    type: boolean
    description: Print the secrets that would be unset without unsetting them.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Unset a secret by name
    lang: sh
    code: supabase secrets unset MY_SECRET
  - id: example-2
    title: Unset multiple secrets
    lang: sh
    code: supabase secrets unset MY_SECRET OTHER_SECRET
  - id: example-3
    title: Unset every custom secret after confirming
    lang: sh
    code: supabase secrets unset --all
  - id: example-4
    title: Preview which secrets --all would unset
    lang: sh
    code: supabase secrets unset --all --dry-run
---

Remove one or more secrets from the linked project by name, or every custom secret with `--all`. Use `--dry-run` to preview what would be removed.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
