---
id: link
kind: command
category: general
title: link
symbol: supabase link
summary: Link to a hosted Supabase project
usage: supabase link [ref-or-branch] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: ref-or-branch
    location: positional
    required: false
  - name: --project-ref
    location: flag
    type: string
    description: Project ref, or the name of one of its branches; deprecated in favor of the argument.
  - name: --skip-pooler
    location: flag
    type: boolean
    description: Use a direct connection instead of the connection pooler.
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase link abcdefghijklmnopqrst
    response: |
      Finished supabase link.
  - id: link-branch
    title: Link a branch by name
    lang: sh
    code: supabase link my-branch
    response: |
      Finished supabase link.
  - id: using-alternate-dns
    title: Link using DNS-over-HTTPS resolver
    lang: sh
    code: supabase link abcdefghijklmnopqrst --dns-resolver https
    response: |
      Finished supabase link.
---

Connects the current directory to a hosted Supabase project so commands such as `db push --remote` and `db pull --remote` target it. Pass the project ref, or the name of one of its branches, as the argument: `supabase link <ref>`. The `--project-ref` flag still works.

Linking records the project ref under `supabase/.temp/`, so later commands target that project without `--project-ref`. It never connects to the database, so it needs no database password.

Passing a bare `--remote` to commands such as `db dump`, `db push`, and `db pull` targets the linked project, so link it first.
