## supabase-db-lint

Find errors in your database functions by running the `plpgsql_check` extension against all schemas. Use it to catch mistakes before you push a migration.

It lints the local database by default, which requires the local development stack to be running. Pass `--remote` to lint the linked project, or `--remote=<ref|branch|url>` to lint another project, a branch of the linked project, or a database URL such as a self-hosted database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

The default lint level is `warning`. Raise it to `error` with `--level`, and lint only some schemas with `--schema`.

Use `--fail-on` to control when the command exits with a non-zero status, which is useful in CI/CD pipelines. The possible values are:

- `none` (default): Always exit with a zero status code, regardless of lint results.
- `warning`: Exit with a non-zero status code if any warnings or errors are found.
- `error`: Exit with a non-zero status code only if errors are found.
