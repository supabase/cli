# Spark command tree (`[experimental.spark] enabled`)

When `[experimental.spark] enabled = true` (or `SUPABASE_EXPERIMENTAL_SPARK_ENABLED`) is set, the
root command tree is replaced by: `init`, `stack`, `start`, `status`, `stop` (the local stack
harness, unchanged), `link`, `db diff`, `db pull`, `db push`, `db reset`, `migration list` and
`gen types`. Every other command, including `db dump`, `db lint`, `inspect db` and `test db`, is
absent and fails as an unknown command.

`link`, `db diff`, `db pull`, `db push`, `migration list` and `gen types` reach the project only
through the Management API: base URL from the profile's `api_url` (`SUPABASE_PROFILE`, a
built-in name or a YAML file), token from
`SUPABASE_ACCESS_TOKEN` or the stored login, ref from `--project-ref`, `SUPABASE_PROJECT_ID` or
`supabase/.link.json`. They never call `/_spark`, `/_dev` or use a service_role key.

## Files Read

- `supabase/config.toml` and project `.env*` (the opt-in; the shadow Postgres image and settings).
- `supabase/.link.json` (the linked ref).
- `supabase/schemas/**/*.sql` and `supabase/schemas/.pgdelta-export.json` (`db diff`).
- `supabase/migrations/<version>_<name>.sql` (`db push`, `migration list`).

## Files Written

- `supabase/.link.json` and `supabase/.gitignore` (`link`).
- `supabase/schemas/**/*.sql` and `supabase/schemas/.pgdelta-export.json` (`db pull`, through the
  declarative writer: stale managed files removed, unmanaged files kept).
- `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` (`db diff -f <name>`, only when the dry run
  refuses nothing).
- `db reset` rewrites the local Spark database through `spark --workdir <project> db reset`.

## API Routes

- `GET /v1/projects/{ref}` (`link`).
- `GET /v1/projects/{ref}/database/dump[?schemas=a,b]`, `application/sql` (`db diff`, `db pull`).
- `POST /v1/projects/{ref}/database/migrations?dry_run=true` with `{query, name}`, answering
  `{statuses: [{index, kind, status, message?, line?, statement}]}` (`db diff`, `db push`).
- `GET /v1/projects/{ref}/database/migrations` (`db push`, `migration list`).
- `POST /v1/projects/{ref}/database/migrations` with `{query, name, version}` (`db push`).
- `GET /v1/projects/{ref}/types/typescript?included_schemas=public` (`gen types`).

The dump and dry-run routes are not in the Management API OpenAPI spec yet and are called with
the same base URL and bearer token as the typed client.

## Docker

`db diff` starts two `supabase/postgres` shadow containers (one loaded with the dump, one clean
for the schema files) and `db pull` one; all are removed with `docker rm -f -v` when the command
ends.

## Environment Variables

`SUPABASE_EXPERIMENTAL_SPARK_ENABLED`, `SUPABASE_EXPERIMENTAL_SPARK_EXECUTABLE` (`db reset`),
`SUPABASE_PROFILE`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`.

## Exit Codes

- `0`: success, including `db diff` with no changes (`No schema changes found` on stdout).
- `1`: an API, shadow or pg-delta failure, or a dry run in which Spark refuses a statement
  (`SparkMigrationRefusedError`; every refused statement is printed on stderr with its status,
  kind, statement and message, and nothing is written or applied).

## Telemetry Events Fired

`cli_command_executed` for each command, through `withCommandTelemetry`.

## Output

### `--output-format text`

- `db diff`: `Dry run on Spark: OK (<n> statement(s))` on stderr, then the SQL on stdout, or
  `Created new migration at supabase/migrations/<file>` on stderr with `-f`.
- `db pull`: `Finished supabase db pull.`; `db push`: `Finished supabase db push.` or
  `Remote database is up to date.`; `link`: `Finished supabase link.`
- `migration list`: a Local / Remote / Time (UTC) table. `gen types`: the types on stdout.

### `--output-format json`

`migration list` emits `{migrations: [{local, remote, time}]}`; the others emit their text.

## Notes

`db push` sends each local migration's version so the remote history matches the files.
`db diff` reports refusals of the generated migration, not the schema-file line that produced
them.
