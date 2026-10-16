## supabase-db-lint

Lints local database for schema errors.

Requires the local development stack to be running when linting against the local database. To lint against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively. With no target flag the command lints the workspace target, which is the local database unless `SUPABASE_TARGET` or `target` in `config.toml` says otherwise. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

Runs the `plpgsql_check` extension against the local database (native or container) to check for errors in all schemas. The default lint level is `warning` and can be raised to error via the `--level` flag.

To lint against specific schemas only, pass in the `--schema` flag.

The `--fail-on` flag can be used to control when the command should exit with a non-zero status code. The possible values are:

- `none` (default): Always exit with a zero status code, regardless of lint results.
- `warning`: Exit with a non-zero status code if any warnings or errors are found.
- `error`: Exit with a non-zero status code only if errors are found.

This flag is particularly useful in CI/CD pipelines where you want to fail the build based on certain lint conditions.
