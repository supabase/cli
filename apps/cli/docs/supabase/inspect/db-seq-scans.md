# db-seq-scans

This command displays the number of sequential scans recorded against all tables, descending by count of sequential scans. Tables that have very high numbers of sequential scans may be underindexed, and it may be worth investigating queries that read from these tables.

```
                  NAME               │ COUNT
  ───────────────────────────────────┼─────────
    emails                           │ 182435
    users                            │  25063
    job_run_details                  │     60
    schema_migrations                │      0
    migrations                       │      0
```

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
