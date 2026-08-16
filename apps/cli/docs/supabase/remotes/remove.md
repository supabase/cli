## supabase-remotes-remove

Removes a named remote from `supabase/config.toml` (or `supabase/config.json`).

```
supabase remotes remove staging
```

Refuses to remove a remote whose `[remotes.<name>]` block declares any key besides `project_id` — remove the extra config first. Removing the last configured remote leaves no empty `[remotes]` table behind.
