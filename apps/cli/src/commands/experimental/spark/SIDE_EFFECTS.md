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

## Dev-instance mode (`[experimental.spark] dev_instance`)

With `dev_instance = true` (or `SUPABASE_EXPERIMENTAL_SPARK_DEV_INSTANCE`) on a Spark project, the
tree is `init`, `stack` (stack backend), `login`, `logout`, `orgs list`, `projects list|create|delete|api-keys`,
`functions new|list|deploy|delete`, `secrets set|list|unset` (the mainline commands, with their own side
effects), `start`, `status`, `stop`, `link`, and the `db`, `migration` and `gen` groups above. No local
stack is started or read.

- `functions list|deploy|delete` and `secrets set|list|unset` act on the dev instance when neither
  `--project-ref` nor `--remote` is given: its ref comes from the state file (no file, or one
  `start` has not finished, fails as the `db` commands do), and the target banner names the
  instance. `--project-ref` and `--remote` resolve as in the mainline tree. Their API routes,
  confirmations (`--yes` in JSON, piped and agent runs) and output are the mainline ones
  (`commands/functions/*/SIDE_EFFECTS.md`, `commands/secrets/*/SIDE_EFFECTS.md`), including the
  linked-project cache those commands write after resolving a ref. `functions new` is the mainline
  command. There is no `functions serve` or `functions download`.
- `functions deploy` uploads through the API (`POST /v1/projects/{ref}/functions/deploy?slug=`
  multipart, then `PUT /v1/projects/{ref}/functions` when two or more functions changed), on any
  target, so Docker is never used; an explicit `--use-docker` or `--legacy-bundle` fails before any
  call. After a deploy to the dev instance it prints `Function <slug>: <api_url>/functions/v1/<slug>`
  on stdout for each function this run deployed, not the disabled ones (with `--output-format json`,
  `function_urls: {<slug>: <url>}`).

- The default target of `db diff|pull|push|query`, `migration fetch|list` and `gen types` is the
  dev instance recorded in `supabase/.temp/dev-instance.json`, reached like a linked project
  through the Management API with its ref; its writes ask for no confirmation, as on the local
  target. `--remote` still selects the linked project. There is no local stack, so `--local`
  fails (`... has no local stack ...`) before any call. Without the file they fail with
  `No dev instance for this project.` and name `supabase start`; with a file `start` has not
  finished, they fail with `... is not set up yet.` and name `supabase start`. When the file's
  `management_api_url` is not the profile's `api_url`, they fail and name both.
- `start`, `stop --delete` and `db reset` hold `supabase/.temp/dev-instance.lock` (an SQLite file
  lock) for their whole run; while another command holds it they fail at once, naming the file,
  and change nothing.
- `start [--org <slug>]`: needs an access token. When the state file's project still answers
  `GET /v1/projects/{ref}`, it is reused (`Using dev instance <name> (<ref>).`), or, when an
  earlier `start` stopped before recording the keys, finished
  (`Finishing the setup of dev instance <name> (<ref>)...`). Otherwise the organization is
  `--org`, the linked project's (`supabase/.link.json`), or the account's only one (several, or
  none, fail and say how to choose); it creates `dev-<folder>-<6 hex>` with `POST /v1/projects`
  `{name, organization_slug, postgres_engine: "spark"}` (no `db_pass`, no region) and writes the
  state file at once with the ref. It then polls `GET /v1/projects/{ref}` every second until
  `status` is `ACTIVE_HEALTHY` (60 s, then it fails naming the ref and its last status, and a
  later `start` keeps waiting for the same project), reads `GET /v1/projects/{ref}/api-keys`
  (`anon`, `service_role`) and adds the URL and keys to the state file. The API URL is the
  project's `api_url`, or `https://<ref>.<project_host>` when it is absent or `null`. It then
  applies the pending migrations as `db push` does (without its confirmation) and, unless the
  state file records the seed as run, runs the `[db.seed] sql_paths` files, each as one
  `POST /v1/projects/{ref}/database/query`, and records it. A seed pattern that matches no file
  prints `WARN: no files matched pattern: <pattern>` on stderr. It prints what `status` prints.
- `status [--env]`: one `GET /v1/projects/{ref}`; prints the name, ref, status, API, REST, Auth and
  Functions URLs and the anon and service_role keys. With no state file, one `start` has not
  finished, or a project that no longer exists, it exits 1.
- `stop`: changes nothing and says how to delete the instance. `stop --delete`:
  `DELETE /v1/projects/{ref}` (a 404 counts as deleted), then removes the state file; it works on
  an instance `start` has not finished.
- `db reset`: `POST /v1/projects/{ref}/database/reset` with `{}`; once that succeeds it records the
  seed as not run (a rejected reset leaves the state file as it was), then runs the pending
  migrations and the seed files as `start` runs them, and records the seed as run. A seed file
  that fails names the file and says to run `supabase db reset`, since the files before it were
  committed.

## Files Read

- `supabase/config.toml` and project `.env*` (the opt-in; the shadow Postgres image and settings).
- `supabase/.link.json` (the linked ref; on the local target too, to hint that a linked project exists).
- `supabase/.temp/dev-instance.json` (dev-instance mode: the default target's ref), and the
  `[db.seed] sql_paths` files (`start` until the seed has run, `db reset` in dev-instance mode).
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
- `supabase/.temp/dev-instance.json`, mode 0600, published atomically (staged as
  `supabase/.temp/.dev-instance.json.<pid>-<n>.tmp`, then renamed) by `start` and `db reset` in
  dev-instance mode, removed by `stop --delete`: `{ref, name, organization_slug,
management_api_url, api_url?, anon_key?, service_role_key?, seeded?}`. `api_url` and the keys are
  absent until `start` finishes; `seeded` is whether the seed files ran on the current database.
  Before the first write, `.temp` is appended to `supabase/.gitignore` when that file (created if
  missing, left alone when it is a symlink) does not list it. `start` does this, and publishes and
  removes a `dev-instance.json.probe` file there, before it creates a project, so a local write
  error creates nothing remote.
- `supabase/.temp/dev-instance.lock` (`start`, `stop --delete`, `db reset` in dev-instance mode).

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

`SUPABASE_EXPERIMENTAL_SPARK_ENABLED`, `SUPABASE_EXPERIMENTAL_SPARK_DEV_INSTANCE`,
`SUPABASE_EXPERIMENTAL_SPARK_EXECUTABLE` (`db reset`),
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
- Dev-instance `status` and `start`: one `<label>: <value>` row each for the instance, status,
  URLs and keys on stdout (progress on stderr); `--env` or `-o env` prints `API_URL`, `REST_URL`,
  `AUTH_URL`, `FUNCTIONS_URL`, `ANON_KEY` and `SERVICE_ROLE_KEY` as dotenv; `-o json|yaml|toml`
  prints `{name, ref, status, api_url, rest_url, auth_url, functions_url, anon_key,
service_role_key}`.

### `--output-format json`

`migration list` emits `{migrations: [{local, remote, time}]}`; dev-instance `status` and `start`
emit the `-o json` object (with `--env`, the variables); `migration fetch` emits
`{files: [<absolute path>]}` with the message `Migration history fetched`; the others emit their
text.

## Notes

`db push` sends each local migration's version so the remote history matches the files.
`db diff` reports refusals of the generated migration, not the schema-file line that produced
them.
