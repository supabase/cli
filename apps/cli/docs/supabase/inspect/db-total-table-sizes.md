# db-total-table-sizes

This command displays the total size of each table in the database. It is the sum of the values that `pg_table_size()` and `pg_indexes_size()` gives for each table. System tables inside `pg_catalog` and `information_schema` are not included.

```
                NAME               │    SIZE
───────────────────────────────────┼─────────────
  job_run_details                  │ 395 MB
  slack_msgs                       │ 648 kB
  emails                           │ 640 kB
```

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
