## db-bloat

This command displays an estimation of table "bloat" - Due to Postgres' [MVCC](https://www.postgresql.org/docs/current/mvcc.html) when data is updated or deleted new rows are created and old rows are made invisible and marked as "dead tuples". Usually the [autovaccum](https://supabase.com/docs/guides/platform/database-size#vacuum-operations) process will asynchronously clean the dead tuples. Sometimes the autovaccum is unable to work fast enough to reduce or prevent tables from becoming bloated. High bloat can slow down queries, cause excessive IOPS and waste space in your database.

Tables with a high bloat ratio should be investigated to see if there are vacuuming is not quick enough or there are other issues.

```
    TYPE  │ SCHEMA NAME │        OBJECT NAME         │ BLOAT │ WASTE
  ────────┼─────────────┼────────────────────────────┼───────┼─────────────
    table │ public      │ very_bloated_table         │  41.0 │ 700 MB
    table │ public      │ my_table                   │   4.0 │ 76 MB
    table │ public      │ happy_table                │   1.0 │ 1472 kB
    index │ public      │ happy_table::my_nice_index │   0.7 │ 880 kB
```

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
