## supabase-init

Initialize configurations for Supabase local development.

A `supabase/config.toml` file is created in your current working directory. This configuration is specific to each local project.

> You may override the directory path by specifying the `SUPABASE_WORKDIR` environment variable or `--workdir` flag.

In addition to `config.toml`, the `supabase` directory may also contain other Supabase objects, such as `migrations`, `functions`, `tests`, etc.

To use OrioleDB as the Postgres storage engine, run `supabase init --use-orioledb`. The command writes the OrioleDB version to `experimental.orioledb_version` in `supabase/config.toml`; `--experimental` is not required.
