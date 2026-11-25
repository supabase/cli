---
id: inspect-db-blocking
kind: command
category: Inspect
title: inspect db blocking
symbol: supabase inspect db blocking
summary: Show blocking queries
usage: supabase inspect db blocking [flags]
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
    title: Show blocked statements on the local database
    lang: sh
    code: supabase inspect db blocking
  - id: example-2
    title: Show blocked statements on the linked project
    lang: sh
    code: supabase inspect db blocking --remote
---

List statements that hold locks and the statements they block. Use it together with `inspect db locks` to decide which statements to terminate to resolve lock contention.

```
    BLOCKED PID │ BLOCKING STATEMENT           │ BLOCKING DURATION │ BLOCKING PID │ BLOCKED STATEMENT                                                                      │ BLOCKED DURATION
  ──────────────┼──────────────────────────────┼───────────────────┼──────────────┼────────────────────────────────────────────────────────────────────────────────────────┼───────────────────
    253         │ select count(*) from mytable │ 00:00:03.838314   │        13495 │ UPDATE "mytable" SET "updated_at" = '2023─08─03 14:07:04.746688' WHERE "id" = 83719341 │ 00:00:03.821826
```
