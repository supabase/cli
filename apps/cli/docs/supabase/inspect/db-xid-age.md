# db-xid-age

This command lists all user tables sorted by their transaction ID (XID) age, from oldest to newest. PostgreSQL wraps around at approximately 2 billion transactions. As a table's XID age approaches that limit, PostgreSQL is forced to perform an emergency autovacuum freeze — an operation that can make the database temporarily unavailable and cannot be deferred.

Tables with an XID age above 1.5 billion transactions (`transactions_remaining` below 500 million) should be treated as urgent: manual `VACUUM FREEZE` or a tuned autovacuum run is needed. Regular monitoring of this view helps prevent the wraparound event before it becomes an emergency.

```
          TABLE          │  XID AGE  │ TRANSACTIONS REMAINING
─────────────────────────┼───────────┼────────────────────────
 public.events           │ 800000000 │           1200000000
 public.users            │ 500000000 │           1500000000
 public.sessions         │ 120000000 │           1880000000
```
