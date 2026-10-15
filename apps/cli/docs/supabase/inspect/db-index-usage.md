# db-index-usage

This command provides information on the efficiency of indexes, represented as what percentage of total scans were index scans. A low percentage can indicate under indexing, or wrong data being indexed.

```
       TABLE NAME     │ PERCENTAGE OF TIMES INDEX USED │ ROWS IN TABLE
  ────────────────────┼────────────────────────────────┼────────────────
    user_events       │                             99 │       4225318
    user_feed         │                             99 │       3581573
    unindexed_table   │                              0 │        322911
    job               │                            100 │         33242
    schema_migrations │                             97 │             0
    migrations        │ Insufficient data              │             0
```

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
