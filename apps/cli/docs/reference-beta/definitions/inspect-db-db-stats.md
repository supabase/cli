---
id: inspect-db-db-stats
kind: command
category: Inspect
title: inspect db db-stats
symbol: supabase inspect db db-stats
summary: Show database stats
usage: supabase inspect db db-stats [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: example-1
    title: Show database stats for the local database
    lang: sh
    code: supabase inspect db db-stats
  - id: example-2
    title: Show database stats for the linked project
    lang: sh
    code: supabase inspect db db-stats --remote
---

Report cache hit rates, database, table, index and TOAST sizes, WAL size, and the time since statistics were reset. Start here for a quick health check of a database.
