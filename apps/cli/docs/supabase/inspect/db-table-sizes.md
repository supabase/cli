# db-table-sizes

This command displays the size of each table in the database. It is calculated by using the system administration function `pg_table_size()`, which includes the size of the main data fork, free space map, visibility map and TOAST data. It does not include the size of the table's indexes.

```
                  NAME               │    SIZE
  ───────────────────────────────────┼─────────────
    job_run_details                  │ 385 MB
    emails                           │ 584 kB
    job                              │ 40 kB
    sessions                         │ 0 bytes
    prod_resource_notifications_meta │ 0 bytes
```

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
