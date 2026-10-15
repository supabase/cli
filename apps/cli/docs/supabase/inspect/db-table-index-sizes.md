# db-table-index-sizes

This command displays the total size of indexes for each table. It is calculated by using the system administration function `pg_indexes_size()`.

```
                 TABLE               │ INDEX SIZE
  ───────────────────────────────────┼─────────────
    job_run_details                  │ 10104 kB
    users                            │ 128 kB
    job                              │ 32 kB
    instances                        │ 8192 bytes
    http_request_queue               │ 0 bytes
```

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
