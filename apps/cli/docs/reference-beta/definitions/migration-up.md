---
id: migration-up
kind: command
category: migrations
subcategory: migration
title: migration up
symbol: supabase migration up
summary: Apply pending migrations to a database
usage: supabase migration up [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --include-all
    location: flag
    type: boolean
    description: Include all migrations not found in the migration history table.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: example-1
    title: Apply pending migrations to the local database
    lang: sh
    code: supabase migration up
  - id: example-2
    title: Apply all missing migrations to the linked project
    lang: sh
    code: supabase migration up --remote --include-all
---

Apply local migrations that are not yet in the migration history of a database. Unlike db push, it only runs migrations and does not push roles, seeds, or vault secrets.
