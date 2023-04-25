## supabase-db-lint

Lints local database for schema errors.

Requires the local development stack to be running when linting against the local database. To lint against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively.

Runs `plpgsql_check` extension in the local Postgres container to check for errors in all schemas. The default lint level is error and is configurable via the `--level` flag.

To lint against specific schemas only, pass in the `--schema` flag.
