# db-traffic-profile

This command analyzes table I/O patterns to show read/write activity ratios based on block-level operations. It combines data from PostgreSQL's `pg_stat_user_tables` (for tuple operations) and `pg_statio_user_tables` (for block I/O) to categorize each table's workload profile.


The command classifies tables into categories:
- **Read-Heavy** - Read operations are more than 5x write operations (e.g., 1:10, 1:50)
- **Write-Heavy** - Write operations are more than 20% of read operations (e.g., 1:2, 1:4, 2:1, 10:1)
- **Balanced** - Mixed workload where writes are between 20% and 500% of reads
- **Read-Only** - Only read operations detected
- **Write-Only** - Only write operations detected

```
SCHEMA │ TABLE        │ BLOCKS READ │ WRITE TUPLES │ BLOCKS WRITE │ ACTIVITY RATIO
───────┼──────────────┼─────────────┼──────────────┼──────────────┼────────────────────
public │ user_events  │     450,234 │     9,004,680│       23,450 │ 20:1 (Write-Heavy)
public │ users        │      89,203 │        12,451│        1,203 │ 7.2:1 (Read-Heavy)
public │ sessions     │      15,402 │        14,823│        2,341 │ ≈1:1 (Balanced)
public │ cache_data   │     123,456 │             0│            0 │ Read-Only
auth   │ audit_logs   │           0 │        98,234│       12,341 │ Write-Only
```

**Note:** This command only displays tables that have had both read and write activity. Tables with no I/O operations are not shown. The classification ratio threshold (default: 5:1) determines when a table is considered "heavy" in one direction versus balanced.

