## supabase-db-lint

Lints a database for schema errors.

Lints the local database by default, which requires the local development stack to be running. Pass `--remote` to lint the linked project, or `--remote=<ref|branch|url>` to lint another project, a branch of the linked project, or a database URL such as a self-hosted database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Runs the `plpgsql_check` extension against the local database (native or container) to check for errors in all schemas. The default lint level is `warning` and can be raised to error via the `--level` flag.

To lint against specific schemas only, pass in the `--schema` flag.

The `--fail-on` flag can be used to control when the command should exit with a non-zero status code. The possible values are:

- `none` (default): Always exit with a zero status code, regardless of lint results.
- `warning`: Exit with a non-zero status code if any warnings or errors are found.
- `error`: Exit with a non-zero status code only if errors are found.

This flag is particularly useful in CI/CD pipelines where you want to fail the build based on certain lint conditions.
