## supabase-link

Link your local development project to a hosted Supabase project.

Use your project ID for `--project-ref`, you can find it in your dashboard url: `https://app.supabase.com/project/<project-id>`

PostgREST configurations are fetched from the Supabase platform and validated against your local configuration file.

Optionally, database settings can be validated if you provide a password. Your database password is saved in native credentials storage if available.

> If you do not want to be prompted for the database password, such as in a CI environment, you may specify it explicitly via the `SUPABASE_DB_PASSWORD` environment variable.

Some commands like `db dump`, `db push`, and `db pull` require your project to be linked first.
