---
id: inspect-db-role-stats
kind: command
category: inspect
subcategory: inspect
title: inspect db role-stats
symbol: supabase inspect db role-stats
summary: Show role stats
usage: supabase inspect db role-stats [flags]
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
    title: Show role stats for the local database
    lang: sh
    code: supabase inspect db role-stats
  - id: example-2
    title: Show role stats for the linked project
    lang: sh
    code: supabase inspect db role-stats --remote
---

Report each role with its active connections, connection limit, and custom configuration. Use it to see which role uses the most connections.
