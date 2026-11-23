# Spark command tree (`[experimental.spark] enabled`)

When `[experimental.spark] enabled = true` (or `SUPABASE_EXPERIMENTAL_SPARK_ENABLED`) is set, the
root command tree is replaced by: `init`, `stack`, `start`, `status`, `stop` (the local stack
harness, unchanged), `link`, `db diff`, `db pull`, `db push`, `db query`, `db reset`,
`migration fetch`, `migration list` and `gen types`. Every other command, including `db dump`, `db lint`, `inspect db` and `test db`, is
absent and fails as an unknown command.

`db diff`, `db pull`, `db push`, `db query`, `migration fetch`, `migration list` and `gen types`
take the mainline target flags without `--db-url`, and the target decides how they reach the project:

- Local (the default): the Spark server of the project's running stack, through the stack's API
  URL (`[api] port`) with the stack's service_role key. No profile, access token or link is read.
  When no stack runs for the project, the command fails and names `supabase start` and `--remote`.
- Linked (`--remote`, `--remote=<ref>`, or the deprecated `--linked` and `--project-ref`): the
  Management API, with the base URL from the profile's `api_url` (`SUPABASE_PROFILE`, a built-in
  name or a YAML file), the token from `SUPABASE_ACCESS_TOKEN` or the stored login, and the ref
  from the flag, `SUPABASE_PROJECT_ID` or `supabase/.link.json`. It never calls `/_spark` or uses
  a service_role key.

`link` always uses the Management API.

## Files Read

- `supabase/config.toml` and project `.env*` (the opt-in; the shadow Postgres image and settings).
- `supabase/.link.json` (the linked ref; on the local target too, to hint that a linked project exists).
- `supabase/schemas/**/*.sql` and `supabase/schemas/.pgdelta-export.json` (`db diff`).
- `supabase/migrations/<version>_<name>.sql` (`db push`, `migration list`), and the directory's
  entries (`migration fetch`, to decide whether to ask before overwriting).
- The `--file` path of `db query` (relative to the workdir), or piped stdin when no SQL argument
  and no `--file` is given.

## Files Written

- `supabase/.link.json` and `supabase/.gitignore` (`link`).
- `supabase/schemas/**/*.sql` and `supabase/schemas/.pgdelta-export.json` (`db pull`, through the
  declarative writer: stale managed files removed, unmanaged files kept).
- `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` (`db diff -f <name>`, only when the dry run
  refuses nothing).
- `supabase/migrations/<version>_<name>.sql`, mode 0644, one per row of the project's migration
  history (`migration fetch`); the directory is created after the history is read.
- `db reset` rewrites the local Spark database through `spark --workdir <project> db reset`.

## API Routes

Local target, on the stack's API URL with `apikey` and `Authorization: Bearer` set to the
service_role key:

- `POST /database/query` with `{query, parameters: [], read_only}` (`db query`; `migration fetch`
  with `read_only: true`).
- `GET /system/v1/migrations` (`db push`, `migration list`).
- `POST /system/v1/migrations?dry_run=1` with `{version, name, sql}`, the version taken from the
  current time (`db diff`, `db push`).
- `POST /system/v1/migrations` with `{version, name, sql}`, the file's version (`db push`).
- `GET /_spark/v1/dump[?schemas=a,b]` (`db diff`, `db pull`): Spark renders the dump.
- `GET /_spark/v1/schema` (`gen types`): the types are rendered in the CLI from the description.

Linked target, and `link`:

- `GET /v1/projects/{ref}` (`link`).
- `GET /v1/projects/{ref}/database/dump[?schemas=a,b]`, `application/sql` (`db diff`, `db pull`).
- `POST /v1/projects/{ref}/database/migrations?dry_run=true` with `{query, name}`, answering
  `{statuses: [{index, kind, status, code?, message?, line?, statement}]}` (`db diff`, `db push`).
- `GET /v1/projects/{ref}/database/migrations` (`db push`, `migration list`).
- `POST /v1/projects/{ref}/database/migrations` with `{query, name, version}` (`db push`).
- `POST /v1/projects/{ref}/database/query` with `{query}`, plus `read_only: true` with
  `--read-only`, answering 201 and a JSON array of rows (`db query`; `migration fetch`, always
  with `read_only: true`).
- `GET /v1/projects/{ref}/types/typescript?included_schemas=public` (`gen types`).

The dump and dry-run routes are not in the Management API OpenAPI spec yet and are called with
the same base URL and bearer token as the typed client.

`db query` prints the rows on stdout: a table by default, JSON for an agent or with `-o json` (one
result event with `--output-format stream-json`), CSV with `-o csv`. A statement that returns no
rows prints nothing. It runs the statement on the project's database, so it may write there: on a
linked project, a statement without `--read-only` asks for confirmation (`--yes` or a shell
`SUPABASE_YES` in JSON, piped and agent runs). On either target, Spark runs it as its query route
runs it, schema changes included, without recording a migration.

`migration fetch` reads the history with one read-only statement on either target,
`select version, coalesce(name, '') as name, coalesce(array_to_string(statements, ';' || chr(10)), '') as sql from supabase_migrations.schema_migrations order by version`,
and writes each row's `sql` followed by `;\n`, which is the file the mainline command writes from
the `statements` array. When `supabase/migrations` is not empty it first asks
`Overwrite local migrations with the history from <target>?` (default yes) and declining exits 1
with `context canceled`, before the history is read; `--yes` or `SUPABASE_YES` (shell env or the
project's `.env`) answers it, and a run with no terminal takes the default. A `version` or `name`
with a path separator or a `..` segment is refused. The Management API has no route that returns
a Spark migration's statements, so the linked target uses the query route too.

## Docker

`db diff` and `db pull` each start two `supabase/postgres` shadow containers (one loaded with the
dump, one clean, for the schema files or the image's own objects), wait up to 10 minutes (or
`db.health_timeout` when longer) for their first boot to accept a connection, and remove them
with `docker rm -f -v` when the command ends.

## Environment Variables

`SUPABASE_EXPERIMENTAL_SPARK_ENABLED`, `SUPABASE_EXPERIMENTAL_SPARK_EXECUTABLE` (`db reset`),
`SUPABASE_HOME` (where the local target finds the project's stack), and for a linked target
`SUPABASE_PROFILE`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_YES`.
`SUPABASE_YES` also answers `migration fetch`'s overwrite prompt on the local target.

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
- `migration fetch`: nothing on success, after the overwrite prompt on stderr.

### `--output-format json`

`migration list` emits `{migrations: [{local, remote, time}]}`; `migration fetch` emits
`{files: [<absolute path>]}` with the message `Migration history fetched`; the others emit their
text.

## Notes

`db push` sends each local migration's version so the remote history matches the files.
`db diff` reports refusals of the generated migration, not the schema-file line that produced
them.
