---
id: inspect-db-table-stats
kind: command
category: inspect
subcategory: inspect
title: inspect db table-stats
symbol: supabase inspect db table-stats
summary: Show table stats
usage: supabase inspect db table-stats [flags]
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
    title: Show table stats for the local database
    lang: sh
    code: supabase inspect db table-stats
  - id: example-2
    title: Show table stats for the linked project
    lang: sh
    code: supabase inspect db table-stats --remote
---

Report each table with its table, index and total size, estimated row count, and sequential scan count. Use it to find the largest tables and how they are scanned.
