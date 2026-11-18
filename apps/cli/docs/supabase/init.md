## supabase-init

Creates `supabase/config.toml` in the current directory, the starting point for local development with `supabase start`. Run it once in each project.

The `supabase` directory can also hold other project files, such as `migrations`, `functions`, and `tests`.

To use another directory, set the `SUPABASE_WORKDIR` environment variable or pass the `--workdir` flag.

To use OrioleDB as the Postgres storage engine, run `supabase init --use-orioledb`. The command writes the OrioleDB version to `db.orioledb_version` in `supabase/config.toml`; `--experimental` is not required.
