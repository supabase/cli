# db-vacuum-stats

Show vacuum activity for each table: when it was last vacuumed and auto vacuumed, its row count and dead row count, and whether autovacuum is expected to run.

Postgres keeps old row versions as dead tuples under [MVCC](https://www.postgresql.org/docs/current/mvcc.html) until [autovacuum](https://supabase.com/docs/guides/platform/database-size#vacuum-operations) cleans them. If the dead row count is much higher than the row count, or an expected autovacuum has not run for some time, autovacuum may not be keeping up. Tune your vacuum settings or add compute or disk IOPS.

```
        SCHEMA        │              TABLE               │ LAST VACUUM │ LAST AUTO VACUUM │      ROW COUNT       │ DEAD ROW COUNT │ EXPECT AUTOVACUUM?
──────────────────────┼──────────────────────────────────┼─────────────┼──────────────────┼──────────────────────┼────────────────┼─────────────────────
 auth                 │ users                            │             │ 2023-06-26 12:34 │               18,030 │              0 │ no
 public               │ profiles                         │             │ 2023-06-26 23:45 │               13,420 │             28 │ no
 public               │ logs                             │             │ 2023-06-26 01:23 │            1,313,033 │      3,318,228 │ yes
 storage              │ objects                          │             │                  │             No stats │              0 │ no
 storage              │ buckets                          │             │                  │             No stats │              0 │ no
 supabase_migrations  │ schema_migrations                │             │                  │             No stats │              0 │ no

```
