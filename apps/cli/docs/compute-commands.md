# Compute commands

The experimental Compute command family runs application containers alongside a
project; it is separate from the database instance size. Its commands and local
configuration may change incompatibly while experimental. The family is opt in. Enable it with
`supabase experiments enable compute`, which records the setting in the project's config, or
with `SUPABASE_EXPERIMENTAL_COMPUTE=1` for one process.

The environment variable accepts `1` to enable and `0` to disable. When it is
unset or empty, the config file is used; any other non-empty value reports an
invalid feature-flag value on Compute paths (including their completion), root
help, or root-level completion before a subcommand is chosen.
Unrelated commands do not resolve the Compute flag. Unreadable or malformed
configuration leaves Compute disabled. An environment opt-in applies only to
that process; use the project setting to share the opt-in with teammates and CI.

```sh
supabase experiments enable compute
```

which writes into the project's existing `[experimental]` table:

```toml
[experimental]
compute = true
```

Editing the file by hand works too, as long as the key joins the `[experimental]` table the
file already has. A second `[experimental]` header is invalid TOML, and an unparseable config
leaves Compute disabled without reporting why — `experiments enable` merges into the existing
table and refuses a document it cannot edit safely. `supabase experiments disable compute`
reverses it.

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
