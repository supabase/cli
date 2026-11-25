---
id: db-advisors
kind: command
category: Database
title: db advisors
symbol: supabase db advisors
summary: Check a database for security and performance issues
usage: supabase db advisors [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --fail-on
    location: flag
    type: "[ none | info | warn | error ]"
    description: Issue level at which the command exits with a non-zero status.
    default: none
    allowed_values:
      - none
      - info
      - warn
      - error
  - name: --level
    location: flag
    type: "[ info | warn | error ]"
    description: Minimum issue level to display.
    default: warn
    allowed_values:
      - info
      - warn
      - error
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
  - name: --type
    location: flag
    type: "[ all | security | performance ]"
    description: Type of advisors to check.
    default: all
    allowed_values:
      - all
      - security
      - performance
examples:
  - id: example-1
    title: Check the local database
    lang: sh
    code: supabase db advisors
  - id: example-2
    title: Check the linked project for security issues only
    lang: sh
    code: supabase db advisors --remote --type security
  - id: example-3
    title: Fail a CI run when an error-level issue is found
    lang: sh
    code: supabase db advisors --level error --fail-on error
---

Check a database for common security and performance issues, such as missing RLS policies, unindexed foreign keys, and an exposed `auth.users`. Run it before a release or in CI.

It inspects the local database by default. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
