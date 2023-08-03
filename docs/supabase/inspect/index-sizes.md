# index-sizes

This command displays the size of each each index in the database. It is calculated by taking the number of pages (reported in `relpages`) and multiplying it by the page size (8192 bytes).

```
              NAME              │    SIZE
  ──────────────────────────────┼─────────────
    user_events_index           │ 2082 MB
    job_run_details_pkey        │ 3856 kB
    schema_migrations_pkey      │ 16 kB
    refresh_tokens_token_unique │ 8192 bytes
    users_instance_id_idx       │ 0 bytes
    buckets_pkey                │ 0 bytes
```