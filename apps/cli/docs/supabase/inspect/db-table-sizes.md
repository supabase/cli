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

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
