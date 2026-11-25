---
id: secrets-set
kind: command
category: Secrets
title: secrets set
symbol: supabase secrets set
summary: Set secrets on the linked project
usage: supabase secrets set <NAME=VALUE> ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: NAME=VALUE
    location: positional
    required: true
    variadic: true
  - name: --env-file
    location: flag
    type: string
    description: Read secrets from a .env file.
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Set a secret by name and value
    lang: sh
    code: supabase secrets set MY_SECRET=myvalue
  - id: example-2
    title: Set secrets from a .env file
    lang: sh
    code: supabase secrets set --env-file .env
---

Set one or more secrets on the linked project, from `NAME=VALUE` pairs or a `.env` file. Edge Functions read them as environment variables.

The confirmation lists the secret names, never their values. Pass `--yes` in scripts and CI.
