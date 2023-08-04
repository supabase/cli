# db-vacuum-stats

This shows you stats about the vacuum activities for each table. It estimates the number of rows that are no longer needed (dead rows) and tells you when the table was last automatically cleaned. It's handy for figuring out if the autovacuum settings need tweaking and spot if vacuum might have failed for some tables. Look out for tables with a large dead row count compared their actual number of rows.



```
        SCHEMA        │              TABLE               │ LAST VACUUM │ LAST AUTO VACUUM │      ROW COUNT       │ DEAD ROW COUNT │ EXPECT AUTOVACUUM?
──────────────────────┼──────────────────────────────────┼─────────────┼──────────────────┼──────────────────────┼────────────────┼─────────────────────
 auth                 │ users                            │             │ 2023-06-26 12:34 │               18,030 │              0 │ no
 public               │ profiles                         │             │ 2013-06-26 23:45 │               13,420 │             28 │ no
 public               │ logs                             │             │ 2013-06-26 01:23 │                   12 │          8,228 │ yes
 storage              │ objects                          │             │                  │             No stats │              0 │ no
 storage              │ buckets                          │             │                  │             No stats │              0 │ no
 supabase_migrations  │ schema_migrations                │             │                  │             No stats │              0 │ no

```
