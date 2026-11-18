## db-traffic-profile

Show how read-heavy or write-heavy each table is, based on block-level I/O. It combines tuple operations from `pg_stat_user_tables` with block I/O from `pg_statio_user_tables`.

Each table gets one of these categories:

- **Read-Heavy**: read operations are more than 5x write operations (for example 1:10 or 1:50).
- **Write-Heavy**: write operations are more than 20% of read operations (for example 1:2, 1:4, 2:1 or 10:1).
- **Balanced**: mixed workload where writes are between 20% and 500% of reads.
- **Read-Only**: only read operations detected.
- **Write-Only**: only write operations detected.

```
SCHEMA │ TABLE        │ BLOCKS READ │ WRITE TUPLES │ BLOCKS WRITE │ ACTIVITY RATIO
───────┼──────────────┼─────────────┼──────────────┼──────────────┼────────────────────
public │ user_events  │     450,234 │     9,004,680│       23,450 │ 20:1 (Write-Heavy)
public │ users        │      89,203 │        12,451│        1,203 │ 7.2:1 (Read-Heavy)
public │ sessions     │      15,402 │        14,823│        2,341 │ ≈1:1 (Balanced)
public │ cache_data   │     123,456 │             0│            0 │ Read-Only
auth   │ audit_logs   │           0 │        98,234│       12,341 │ Write-Only
```

Only tables with both read and write activity are shown. The ratio threshold that separates "heavy" from balanced is 5:1.
