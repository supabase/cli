# db-vacuum-stats

This shows you stats about the vacuum activities for each table. Due to Postgres' [MVCC](https://www.postgresql.org/docs/current/mvcc.html) when data is updated or deleted new rows are created and old rows are made invisible and marked as "dead tuples". Usually the [autovaccum](https://supabase.com/docs/guides/platform/database-size#vacuum-operations) process will aysnchronously clean the dead tuples.

The command lists when the last vacuum and last auto vacuum took place, the row count on the table as well as the count of dead rows and whether autovacuum is expected to run or not. If the number of dead rows is much higher than the row count, or if an autovacuum is expected but has not been performed for some time, this can indicate that autovacuum is not able to keep up and that your vacuum settings need to be tweaked or that you require more compute or disk IOPS to allow autovaccum to complete.


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
