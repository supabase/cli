## supabase-init

Initialize configurations for Supabase local development.

A `supabase/config.toml` file is created in your current working directory. This configuration is specific to each local project.

> You may override the directory path by specifying the `SUPABASE_WORKDIR` environment variable or `--workdir` flag.

In addition to `config.toml`, the `supabase` directory may also contain other Supabase objects, such as `migrations`, `functions`, `tests`, etc. You can add an optional `[experimental.pgdelta]` section to enable declarative schema workflows (`enabled`, `declarative_schema_path`, `format_options`).
