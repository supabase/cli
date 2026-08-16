## supabase-remotes-add

Registers a named remote Supabase project in `supabase/config.toml` (or `supabase/config.json`), so it can be targeted per-invocation with the global `--remote <name>` flag instead of relinking your project.

```
supabase remotes add staging --project-ref abcdefghijklmnopqrst
```

Adding a name that already targets the same project ref is a no-op. Adding a name that already exists with a different ref fails without writing.

The remote's project ref is not a secret and is committed with the rest of `supabase/config.toml`.
