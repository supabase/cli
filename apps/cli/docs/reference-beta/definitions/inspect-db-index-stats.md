---
id: inspect-db-index-stats
kind: command
category: inspect
subcategory: inspect
title: inspect db index-stats
symbol: supabase inspect db index-stats
summary: Show index stats
usage: supabase inspect db index-stats [flags]
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
    title: Show index stats for the local database
    lang: sh
    code: supabase inspect db index-stats
  - id: example-2
    title: Show index stats for the linked project
    lang: sh
    code: supabase inspect db index-stats --remote
---

Report each index with its table, columns, size, the share of scans that used it, and whether it is unused. Use it to find large or unused indexes.
