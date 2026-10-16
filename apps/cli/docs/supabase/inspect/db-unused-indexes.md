# db-unused-indexes

This command displays indexes that have < 50 scans recorded against them, and are greater than 5 pages in size, ordered by size relative to the number of index scans. This command is generally useful for discovering indexes that are unused. Indexes can impact write performance, as well as read performance should they occupy space in memory, its a good idea to remove indexes that are not needed or being used.

```
        TABLE        │                   INDEX                    │ INDEX SIZE │ INDEX SCANS
─────────────────────┼────────────────────────────────────────────┼────────────┼──────────────
 public.users        │ user_id_created_at_idx                     │ 97 MB      │           0
```

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
