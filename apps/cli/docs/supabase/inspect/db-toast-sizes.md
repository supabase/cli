# db-toast-sizes

This command displays TOAST table sizes and dead chunk counts for every user table that has a TOAST relation. When a column value exceeds ~2 kB (TEXT, JSONB, bytea), Postgres stores it out-of-line in a companion TOAST table. Autovacuum runs on the TOAST table independently from the main heap, so it can accumulate dead chunks even when the parent table looks healthy by its own dead-tuple count.

A table that appears fine by `vacuum-stats` or `bloat` alone can still have significant TOAST bloat that wastes disk space and slows reads. High `TOAST Dead %` values indicate that autovacuum is not keeping up with the TOAST table and a manual `VACUUM` may be needed.

```
         TABLE          │ TOTAL SIZE │ HEAP SIZE │ TOAST SIZE │ TOAST LIVE CHUNKS │ TOAST DEAD CHUNKS │ TOAST DEAD % │  LAST AUTOVACUUM   │ LAST VACUUM
────────────────────────┼────────────┼───────────┼────────────┼───────────────────┼───────────────────┼──────────────┼────────────────────┼─────────────
 public.documents       │ 4200 MB    │ 800 MB    │ 3400 MB    │            250000 │             18000 │          6.7 │ 2024-03-01 04:12   │
 public.media_assets    │ 890 MB     │ 120 MB    │ 770 MB     │             80000 │               200 │          0.2 │ 2024-03-02 01:45   │
 public.messages        │ 340 MB     │ 280 MB    │ 60 MB      │             95000 │                 0 │          0.0 │ 2024-03-02 03:10   │
```
