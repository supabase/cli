# db-toast-sizes

Show TOAST table sizes and dead chunk counts for each ordinary user table that has a TOAST relation. Materialized views and partitioned parents are not listed.

When a row exceeds about 2 kB, Postgres compresses or moves its largest variable-length values (such as `text`, `jsonb` and `bytea`) into a companion TOAST table. TOAST Size includes the TOAST index, and Total Size also includes the table's own indexes.

Autovacuum runs on the TOAST table separately from the main heap, so a table that looks healthy in `vacuum-stats` or `bloat` can still have TOAST bloat. A high `TOAST Dead %` means autovacuum is not keeping up, and you may need to run `VACUUM` manually.

```
         TABLE          │ TOTAL SIZE │ HEAP SIZE │ TOAST SIZE │ TOAST LIVE CHUNKS │ TOAST DEAD CHUNKS │ TOAST DEAD % │  LAST AUTOVACUUM   │ LAST VACUUM
────────────────────────┼────────────┼───────────┼────────────┼───────────────────┼───────────────────┼──────────────┼────────────────────┼─────────────
 public.documents       │ 4350 MB    │ 800 MB    │ 3400 MB    │            250000 │             18000 │          6.7 │ 2024-03-01 04:12   │
 public.media_assets    │ 905 MB     │ 120 MB    │ 770 MB     │             80000 │               200 │          0.2 │ 2024-03-02 01:45   │
 public.messages        │ 365 MB     │ 280 MB    │ 60 MB      │             95000 │                 0 │          0.0 │ 2024-03-02 03:10   │
```
