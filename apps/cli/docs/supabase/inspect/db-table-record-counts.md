# db-table-record-counts

This command displays an estimated count of rows per table, descending by estimated count. The estimated count is derived from `n_live_tup`, which is updated by vacuum operations. Due to the way `n_live_tup` is populated, sparse vs. dense pages can result in estimations that are significantly out from the real count of rows.

```
       NAME    │ ESTIMATED COUNT
  ─────────────┼──────────────────
    logs       │          322943
    emails     │            1103
    job        │               1
    migrations │               0
```

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
