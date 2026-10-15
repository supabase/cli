# db-total-index-size

This command displays the total size of all indexes on the database. It is calculated by taking the number of pages (reported in `relpages`) and multiplying it by the page size (8192 bytes).

```
    SIZE
  ─────────
    12 MB
```

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
