# db-index-sizes

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

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
