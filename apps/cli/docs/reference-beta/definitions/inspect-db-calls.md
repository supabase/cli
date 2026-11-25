---
id: inspect-db-calls
kind: command
category: inspect
subcategory: inspect
title: inspect db calls
symbol: supabase inspect db calls
summary: Show queries by call count
usage: supabase inspect db calls [flags]
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
    title: List the most frequently called queries on the local database
    lang: sh
    code: supabase inspect db calls
  - id: example-2
    title: List the most frequently called queries on the linked project
    lang: sh
    code: supabase inspect db calls --remote
---

List statements from `pg_stat_statements` ordered by how many times they were called. Use it to find the queries that run most often and are good candidates for optimization.

It works like `supabase inspect db outliers`, but sorts by call count instead of total execution time.

```

                        QUERY                      │ TOTAL EXECUTION TIME │ PROPORTION OF TOTAL EXEC TIME │ NUMBER CALLS │  SYNC IO TIME
  ─────────────────────────────────────────────────┼──────────────────────┼───────────────────────────────┼──────────────┼──────────────────
    SELECT * FROM users WHERE id = $1              │ 14:50:11.828939      │ 89.8%                         │  183,389,757 │ 00:00:00.002018
    SELECT * FROM user_events                      │ 01:20:23.466633      │ 1.4%                          │       78,325 │ 00:00:00
    INSERT INTO users (email, name) VALUES ($1, $2)│ 00:40:11.616882      │ 0.8%                          │       54,003 │ 00:00:00.000322

```
