## supabase-link

Link your local development project to a hosted Supabase project.

PostgREST configurations will be fetched from Supabase platform and validated against your local configuration file.

Optionally, database settings can be validated if you provide a password. Your database password will be saved in native credentials storage if available.

Some commands like `db dump`, `db push`, and `db remote commit` require your project to be linked.
