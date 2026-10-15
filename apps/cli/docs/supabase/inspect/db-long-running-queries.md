# db-long-running-queries

This command displays currently running queries, that have been running for longer than 5 minutes, descending by duration. Very long running queries can be a source of multiple issues, such as preventing DDL statements completing or vacuum being unable to update `relfrozenxid`.

```
  PID  │     DURATION    │                                         QUERY
───────┼─────────────────┼───────────────────────────────────────────────────────────────────────────────────────
 19578 | 02:29:11.200129 | EXPLAIN SELECT  "students".* FROM "students"  WHERE "students"."id" = 1450645 LIMIT 1
 19465 | 02:26:05.542653 | EXPLAIN SELECT  "students".* FROM "students"  WHERE "students"."id" = 1889881 LIMIT 1
 19632 | 02:24:46.962818 | EXPLAIN SELECT  "students".* FROM "students"  WHERE "students"."id" = 1581884 LIMIT 1
```

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
