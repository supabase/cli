# Compute commands

The experimental Compute command family runs application containers alongside a
project; it is separate from the database instance size. Its commands and local
configuration may change incompatibly while experimental. The family is opt in. Enable it with
`SUPABASE_EXPERIMENTAL_COMPUTE=1` or by setting `compute = true` under
`[experimental]` in `supabase/config.toml`.

The environment variable accepts `1` to enable and `0` to disable. When it is
unset or empty, the config file is used; any other non-empty value reports an
invalid feature-flag value on Compute paths (including their completion), root
help, or root-level completion before a subcommand is chosen.
Unrelated commands do not resolve the Compute flag. Unreadable or malformed
configuration leaves Compute disabled. An environment opt-in applies only to
that process; use the project setting to share the opt-in with teammates and CI.

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

`compute new` edits TOML configuration. It refuses projects whose authoritative
configuration is JSON before prompting or writing, so it cannot save deployment
settings into an ignored file. To deploy a source directory without a Compute
configuration entry, `compute push` requires an explicit `--exposure public` or
`--exposure private`. Record the entry in the authoritative config to persist
its deployment settings.
