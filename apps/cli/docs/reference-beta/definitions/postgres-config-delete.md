---
id: postgres-config-delete
kind: command
category: Postgres Config
title: postgres-config delete
symbol: supabase postgres-config delete
summary: Delete Postgres database config overrides
usage: supabase postgres-config delete [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --config
    location: flag
    type: strings
    description: Config keys to delete, comma-separated or repeated.
    variadic: true
  - name: --no-restart
    location: flag
    type: boolean
    description: Do not restart the database after deleting config.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --experimental
    location: flag
    type: boolean
    required: true
    description: enable experimental features
    default: false
examples:
  - id: example-1
    title: Delete a Postgres config override
    lang: sh
    code: supabase postgres-config delete --config work_mem --experimental --remote=<project-ref>
---

Removes the named overrides so those settings return to their defaults. The database restarts afterwards unless you pass `--no-restart`.
