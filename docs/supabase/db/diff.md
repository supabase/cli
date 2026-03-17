# supabase-db-diff

Diffs schema changes made to the local or remote database.

Requires the local development stack to be running when diffing against the local database. To diff against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively.

By default, this command uses migra in a container to compare schema differences between the target database and a shadow database. The shadow database is created by applying migrations in local `supabase/migrations` directory in a separate container. Output is written to stdout by default. For convenience, you can also save the schema diff as a new migration file by passing in `-f` flag.

You can switch engines with diff flags:

- `--use-migra` (default)
- `--use-pgadmin`
- `--use-pg-schema`
- `--use-pg-delta`

To make pg-delta the active engine across commands without repeating `--use-pg-delta`, set `SUPABASE_EXPERIMENTAL_PG_DELTA=1` or add `[experimental.pgdelta] enabled = true` in `supabase/config.toml`.

You can run an explicit diff between two targets by setting both `--from` and `--to`. Allowed values are `local`, `linked`, or a database URL. Use `--output <path>` to write the diff to a file instead of stdout.

By default, all schemas in the target database are diffed. Use the `--schema public,extensions` flag to restrict diffing to a subset of schemas.

While the diff command is able to capture most schema changes, there are cases where it is known to fail. Currently, this could happen if you schema contains:

- Changes to publication
- Changes to storage buckets
- Views with `security_invoker` attributes

The `--use-pg-delta` flow is experimental and follows the CLI experimental gating behavior.
