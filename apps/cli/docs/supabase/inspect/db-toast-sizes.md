# db-toast-sizes

This command displays TOAST table sizes and dead chunk counts for every ordinary user table that has a TOAST relation (materialized views and partitioned parents are not listed). When a row exceeds ~2 kB, Postgres compresses and/or moves its largest variable-length values (TEXT, JSONB, bytea) out-of-line into a companion TOAST table. TOAST Size includes the TOAST index; Total Size also includes the table's own indexes. Autovacuum runs on the TOAST table independently from the main heap, so it can accumulate dead chunks even when the parent table looks healthy by its own dead-tuple count.

A table that appears fine by `vacuum-stats` or `bloat` alone can still have significant TOAST bloat that wastes disk space and slows reads. High `TOAST Dead %` values indicate that autovacuum is not keeping up with the TOAST table and a manual `VACUUM` may be needed.

```
         TABLE          │ TOTAL SIZE │ HEAP SIZE │ TOAST SIZE │ TOAST LIVE CHUNKS │ TOAST DEAD CHUNKS │ TOAST DEAD % │  LAST AUTOVACUUM   │ LAST VACUUM
────────────────────────┼────────────┼───────────┼────────────┼───────────────────┼───────────────────┼──────────────┼────────────────────┼─────────────
 public.documents       │ 4350 MB    │ 800 MB    │ 3400 MB    │            250000 │             18000 │          6.7 │ 2024-03-01 04:12   │
 public.media_assets    │ 905 MB     │ 120 MB    │ 770 MB     │             80000 │               200 │          0.2 │ 2024-03-02 01:45   │
 public.messages        │ 365 MB     │ 280 MB    │ 60 MB      │             95000 │                 0 │          0.0 │ 2024-03-02 03:10   │
```
