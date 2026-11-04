Connects the current directory to a hosted Supabase project so commands such as `db push` and `db pull` target it. Pass the project ref, or the name of one of its branches, as the argument: `supabase link <ref>`. The `--project-ref` flag still works.

The CLI fetches PostgREST configuration from the Supabase platform and validates it against your local configuration file.

If you provide a database password, the CLI also validates the database settings and saves the password in native credentials storage when available.

> To avoid the database password prompt, such as in a CI environment, set the `SUPABASE_DB_PASSWORD` environment variable.

Commands that accept `--remote`, like `db dump`, `db push`, and `db pull`, target the linked project, so link it first.
