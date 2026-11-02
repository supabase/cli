# db-xid-age

This command lists user tables sorted by their transaction ID (XID) age, oldest first. PostgreSQL's transaction ID space wraps around at about 2.1 billion transactions. Once a table's XID age passes `autovacuum_freeze_max_age` (200 million by default), autovacuum forces a freeze on it; if the age keeps growing toward the wraparound limit, PostgreSQL stops assigning new transaction IDs to protect the data. `transactions_remaining` is the headroom to a 2 billion threshold, kept below the real limit as a safety margin.

Tables with an XID age above 1.5 billion transactions (`transactions_remaining` below 500 million) should be treated as urgent: manual `VACUUM FREEZE` or a tuned autovacuum run is needed. Regular monitoring of this view helps prevent the wraparound event before it becomes an emergency.

```
          TABLE          │  XID AGE  │ TRANSACTIONS REMAINING
─────────────────────────┼───────────┼────────────────────────
 public.events           │ 800000000 │           1200000000
 public.users            │ 500000000 │           1500000000
 public.sessions         │ 120000000 │           1880000000
```
