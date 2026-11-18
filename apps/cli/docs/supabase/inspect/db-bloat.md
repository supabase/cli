## db-bloat

Estimate how much space each table and index wastes on dead tuples. Use it to find relations where autovacuum is not keeping up.

When data is updated or deleted, Postgres keeps the old row versions as "dead tuples" under [MVCC](https://www.postgresql.org/docs/current/mvcc.html) until [autovacuum](https://supabase.com/docs/guides/platform/database-size#vacuum-operations) cleans them. High bloat can slow queries, cause excessive IOPS, and waste space.

Investigate tables with a high bloat ratio to see whether vacuuming is too slow or something else is wrong.

```
    TYPE  │ SCHEMA NAME │        OBJECT NAME         │ BLOAT │ WASTE
  ────────┼─────────────┼────────────────────────────┼───────┼─────────────
    table │ public      │ very_bloated_table         │  41.0 │ 700 MB
    table │ public      │ my_table                   │   4.0 │ 76 MB
    table │ public      │ happy_table                │   1.0 │ 1472 kB
    index │ public      │ happy_table::my_nice_index │   0.7 │ 880 kB
```
