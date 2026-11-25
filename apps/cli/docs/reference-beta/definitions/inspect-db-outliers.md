---
id: inspect-db-outliers
kind: command
category: Inspect
title: inspect db outliers
symbol: supabase inspect db outliers
summary: Show query outliers by time
usage: supabase inspect db outliers [flags]
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
    title: List the slowest queries by total execution time on the local database
    lang: sh
    code: supabase inspect db outliers
  - id: example-2
    title: List the slowest queries by total execution time on the linked project
    lang: sh
    code: supabase inspect db outliers --remote
---

List statements from `pg_stat_statements` ordered by total execution time. For each one it shows the statement, its total execution time, its share of all execution time, how often it was called, and the time spent on synchronous I/O (reading and writing the file system).

An efficient query has a reasonable ratio of calls to total execution time and spends as little time on I/O as possible. Investigate queries with a high total execution time but a low call count, and queries that spend a large share of their time on synchronous I/O.

```

                 QUERY                   │ EXECUTION TIME   │ PROPORTION OF EXEC TIME │ NUMBER CALLS │ SYNC IO TIME
─────────────────────────────────────────┼──────────────────┼─────────────────────────┼──────────────┼───────────────
 SELECT * FROM archivable_usage_events.. │ 154:39:26.431466 │ 72.2%                   │ 34,211,877   │ 00:00:00
 COPY public.archivable_usage_events (.. │ 50:38:33.198418  │ 23.6%                   │ 13           │ 13:34:21.00108
 COPY public.usage_events (id, reporte.. │ 02:32:16.335233  │ 1.2%                    │ 13           │ 00:34:19.784318
 INSERT INTO usage_events (id, retaine.. │ 01:42:59.436532  │ 0.8%                    │ 12,328,187   │ 00:00:00
 SELECT * FROM usage_events WHERE (alp.. │ 01:18:10.754354  │ 0.6%                    │ 102,114,301  │ 00:00:00
```
