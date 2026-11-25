---
id: secrets-list
kind: command
category: secrets
subcategory: secrets
title: secrets list
symbol: supabase secrets list
summary: List secrets on the linked project
usage: supabase secrets list [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: List all secrets for the linked project
    lang: sh
    code: supabase secrets list
  - id: example-2
    title: List secrets for a specific project
    lang: sh
    code: supabase secrets list --remote=abcdefghijklmnopqrst
---

Show the names and digests of the secrets set on the linked project. Secret values are never shown.
