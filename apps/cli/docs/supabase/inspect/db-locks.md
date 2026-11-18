# db-locks

List queries that hold an exclusive lock on a relation. Exclusive locks block other operations on that relation and can cause "hung" queries that wait for a lock.

To stop a query that hangs or blocks others, connect to the database and run `SELECT pg_cancel_backend(PID);`. If it keeps running, force it to stop with `SELECT pg_terminate_backend(PID);`.

```
     PID   │ RELNAME │ TRANSACTION ID │ GRANTED │                  QUERY                  │   AGE
  ─────────┼─────────┼────────────────┼─────────┼─────────────────────────────────────────┼───────────
    328112 │ null    │              0 │ t       │ SELECT * FROM logs;                     │ 00:04:20
```
