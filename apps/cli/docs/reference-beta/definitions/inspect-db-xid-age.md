---
id: inspect-db-xid-age
kind: command
category: inspect
subcategory: inspect
title: inspect db xid-age
symbol: supabase inspect db xid-age
summary: Show XID age for user tables
usage: supabase inspect db xid-age [flags]
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
    title: Show XID age on the local database
    lang: sh
    code: supabase inspect db xid-age
  - id: example-2
    title: Show XID age on the linked project
    lang: sh
    code: supabase inspect db xid-age --remote
---

List user tables sorted by transaction ID (XID) age, oldest first. Use it to catch tables that are approaching transaction ID wraparound.

Transaction IDs wrap around at about 2.1 billion transactions. Once a table's XID age passes `autovacuum_freeze_max_age` (200 million by default), autovacuum forces a freeze. If the age keeps growing toward the limit, Postgres stops assigning new transaction IDs to protect the data.

`transactions_remaining` is the headroom to a 2 billion threshold, kept below the real limit as a safety margin. Treat tables with an XID age above 1.5 billion (`transactions_remaining` below 500 million) as urgent, and run a manual `VACUUM FREEZE` or tune autovacuum.

The list covers ordinary user tables only. It leaves out materialized views, TOAST tables, and Supabase-managed schemas, so it does not show the database-wide age. For that, run `SELECT age(datfrozenxid) FROM pg_database WHERE datname = current_database()`.

```
          TABLE          │  XID AGE  │ TRANSACTIONS REMAINING
─────────────────────────┼───────────┼────────────────────────
 public.events           │ 800000000 │           1200000000
 public.users            │ 500000000 │           1500000000
 public.sessions         │ 120000000 │           1880000000
```
