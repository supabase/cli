# Compute commands

The experimental Compute command family is opt in. Enable it with
`SUPABASE_EXPERIMENTAL_COMPUTE=1` or by setting `compute = true` under
`[experimental]` in `supabase/config.toml`.

The environment variable accepts `1` to enable and `0` to disable. When it is
unset or empty, the config file is used; any other non-empty value leaves the
Compute command tree disabled.

```toml
[experimental]
compute = true
```

For `supabase/config.json`, use the equivalent JSON object:

```json
{
  "experimental": {
    "compute": true
  }
}
```

When enabled, the CLI exposes:

- `supabase compute new`
- `supabase compute push`
- `supabase compute list`
- `supabase compute status`
- `supabase compute logs`
- `supabase compute delete`

Compute source directories live under `supabase/compute/<name>/`.
