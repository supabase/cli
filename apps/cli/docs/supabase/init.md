## supabase-init

Initialize configurations for Supabase local development.

A `supabase/config.jsonc` file is created in your current working directory. This configuration is specific to each local project.

> You may override the directory path by specifying the `SUPABASE_WORKDIR` environment variable or `--workdir` flag.

In addition to `config.jsonc`, the `supabase` directory may also contain other Supabase objects, such as `migrations`, `functions`, `tests`, etc.

With `--use-orioledb`, the command writes the OrioleDB version to `db.orioledb_version` in `supabase/config.jsonc`; `--experimental` is not required.

With `--force`, the command replaces the project config with a fresh `supabase/config.jsonc` and removes any `supabase/config.json` or `supabase/config.toml`. Use `supabase config convert --to toml` to switch an initialized project back to TOML.
