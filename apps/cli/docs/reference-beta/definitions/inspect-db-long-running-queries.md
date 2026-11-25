---
id: inspect-db-long-running-queries
kind: command
category: inspect
subcategory: inspect
title: inspect db long-running-queries
symbol: supabase inspect db long-running-queries
summary: Show long-running queries
usage: supabase inspect db long-running-queries [flags]
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
    title: Show long-running queries on the local database
    lang: sh
    code: supabase inspect db long-running-queries
  - id: example-2
    title: Show long-running queries on the linked project
    lang: sh
    code: supabase inspect db long-running-queries --remote
---

List queries that have been running for longer than 5 minutes, longest first. Very long-running queries can prevent DDL statements from completing or stop vacuum from updating `relfrozenxid`.

```
  PID  │     DURATION    │                                         QUERY
───────┼─────────────────┼───────────────────────────────────────────────────────────────────────────────────────
 19578 | 02:29:11.200129 | EXPLAIN SELECT  "students".* FROM "students"  WHERE "students"."id" = 1450645 LIMIT 1
 19465 | 02:26:05.542653 | EXPLAIN SELECT  "students".* FROM "students"  WHERE "students"."id" = 1889881 LIMIT 1
 19632 | 02:24:46.962818 | EXPLAIN SELECT  "students".* FROM "students"  WHERE "students"."id" = 1581884 LIMIT 1
```
