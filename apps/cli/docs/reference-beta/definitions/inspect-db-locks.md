---
id: inspect-db-locks
kind: command
category: inspect
subcategory: inspect
title: inspect db locks
symbol: supabase inspect db locks
summary: Show exclusive locks
usage: supabase inspect db locks [flags]
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
    title: Show exclusive locks on the local database
    lang: sh
    code: supabase inspect db locks
  - id: example-2
    title: Show exclusive locks on the linked project
    lang: sh
    code: supabase inspect db locks --remote
---

List queries that hold an exclusive lock on a relation. Exclusive locks block other operations on that relation and can cause "hung" queries that wait for a lock.

To stop a query that hangs or blocks others, connect to the database and run `SELECT pg_cancel_backend(PID);`. If it keeps running, force it to stop with `SELECT pg_terminate_backend(PID);`.

```
     PID   │ RELNAME │ TRANSACTION ID │ GRANTED │                  QUERY                  │   AGE
  ─────────┼─────────┼────────────────┼─────────┼─────────────────────────────────────────┼───────────
    328112 │ null    │              0 │ t       │ SELECT * FROM logs;                     │ 00:04:20
```
