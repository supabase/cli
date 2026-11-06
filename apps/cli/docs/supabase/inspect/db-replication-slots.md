# db-replication-slots

Show the [logical replication slots](https://www.postgresql.org/docs/current/logical-replication.html) on the database. For each slot it shows whether it is active, the state of the WAL sender process (`startup`, `catchup`, `streaming`, `backup` or `stopping`), the client address, and the replication lag in GB.

Use it to check that replication lag stays low. Lag can come from network latency, slow disk I/O, long-running transactions, or a subscriber that cannot consume WAL fast enough.

```
                       NAME                    │ ACTIVE │ STATE   │ REPLICATION CLIENT ADDRESS │ REPLICATION LAG GB
  ─────────────────────────────────────────────┼────────┼─────────┼────────────────────────────┼─────────────────────
    supabase_realtime_replication_slot         │ t      │ N/A     │ N/A                        │                  0
    datastream                                 │ t      │ catchup │ 24.201.24.106              │                 45
```
