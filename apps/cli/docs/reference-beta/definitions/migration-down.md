---
id: migration-down
kind: command
category: Migrations
title: migration down
symbol: supabase migration down
summary: Revert the last applied migrations
usage: supabase migration down [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --last
    location: flag
    type: int
    description: Number of most recent migrations to revert.
    default: "1"
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: example-1
    title: Revert the most recent migration on the local database
    lang: sh
    code: supabase migration down --last 1
---

Revert the most recent migrations by dropping the user schemas of a database and re-applying the migrations before them. This discards all data in the database, so use it with care.
