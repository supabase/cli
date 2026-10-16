# db-calls

This command is much like the `supabase inspect db outliers` command, but ordered by the number of times a statement has been called.

You can use this information to see which queries are called most often, which can potentially be good candidates for optimisation.

```

                        QUERY                      │ TOTAL EXECUTION TIME │ PROPORTION OF TOTAL EXEC TIME │ NUMBER CALLS │  SYNC IO TIME
  ─────────────────────────────────────────────────┼──────────────────────┼───────────────────────────────┼──────────────┼──────────────────
    SELECT * FROM users WHERE id = $1              │ 14:50:11.828939      │ 89.8%                         │  183,389,757 │ 00:00:00.002018
    SELECT * FROM user_events                      │ 01:20:23.466633      │ 1.4%                          │       78,325 │ 00:00:00
    INSERT INTO users (email, name) VALUES ($1, $2)│ 00:40:11.616882      │ 0.8%                          │       54,003 │ 00:00:00.000322

```

Without `--local`, `--linked` or `--db-url`, the command follows the workspace target (`target = "local"` or `target = "remote"` in `supabase/config.toml`, or the `SUPABASE_TARGET` environment variable) and otherwise targets the linked project. A selector flag always wins; `target = "remote"` also resolves `--project-ref` to the linked project. When the target picks the linked project the command prints `Targeting the linked project (target = "remote" from <source>)` on stderr. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.
