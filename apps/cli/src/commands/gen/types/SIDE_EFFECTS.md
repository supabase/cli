# `supabase gen types`

Generates PostgREST client types against a direct PostgreSQL connection. Introspection runs
in-process via `@supabase/postgrest-typegen`; the language comes from the `@supabase/typegen`
registry, which lists every `--lang` value and either calls that language's generator in-process
(TypeScript, Go, Python, Swift today) or runs the language's own tool in the directory the command
was run from, with the introspected document on stdin (`--lang dart` runs
`dart run supabase_typegen --output -`). A bump of that dependency can add a `--lang` value or a
language flag; the CLI names no language itself. The command is `selectable` and never asks for
hosted-mutation consent. With no selector it targets the local database; `--remote` targets a remote
project: bare for the linked project, `--remote=<ref>`, `--remote=<branch>` for a branch of the
linked project, or `--remote=<db-url>` for a database URL. TypeScript output for a remote project
still comes from the Management API; every other language and target (including local and a database
URL) connects to the database and introspects it directly — no pg-meta container is involved. When
`[experimental].stack` is on, the local target resolves the project stack through `DbConfigResolver`
instead of inspecting `supabase_db_*`. `--linked`, `--project-ref`, `--project-id`, `--db-url` and
`--local` are deprecated aliases.

## Files Read

| Path                                                                    | Format             | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/project-ref`                                  | plain text         | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `<workdir>/supabase/.temp/linked-project.json`                          | JSON               | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `~/.supabase/access-token`                                              | plain text         | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `<workdir>/supabase/config.toml` or `config.json`                       | TOML/JSON          | when selecting schemas on a remote project (a matched `[remotes.<ref>]` block over the base) or with `--remote=<db-url>` (`--schema` omitted; any `--schema` skips the schema load entirely). The local target reads the config through `readDbToml` and always keeps the embedded-default fallback when the file is absent. On the other paths, a DEFAULTED workdir also keeps the embedded-default fallback (`included_schemas` falls back to `public,graphql_public`); an EXPLICIT `--workdir`/`SUPABASE_WORKDIR` that holds no project instead FAILS (`GenTypesMissingProjectConfigError`) rather than silently generating a `public`-only types file — see the exit-code table |
| `<workdir>/supabase/config.json` or `config.toml` (`[db]` values only)  | JSON/TOML          | every `--remote=<db-url>` resolution, regardless of `--schema` — `DbConfigResolver` reads it through `readDbToml` (`config.json` preferred when both exist) to fill a passwordless local DSN's `[db].password` and to classify the target host as local vs. remote. A present-but-unparseable config file fails the command (`DbConfigLoadError`) even on this path, independent of the schema-selecting load above.                                                                                                                                                                                                                                                                |
| `<workdir>{/supabase}/.env*`                                            | dotenv             | the local target; resolves the same nested environment overrides as the CLI. Every `--remote=<db-url>` resolution also reads it (same `.env.<SUPABASE_ENV>.local`/`.env.local`/`.env.<SUPABASE_ENV>`/`.env` search) to populate the `PG*` fallbacks used while parsing the DSN.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `~/.pg_service.conf` (or a `PGSERVICEFILE`/DSN `servicefile=` override) | libpq service file | `--remote=<db-url>`, only when the DSN or `PGSERVICE` names a `service` — its settings fill in for connection fields the DSN itself omits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `<workdir>/supabase/.temp/rest-version`                                 | plain text         | the local target only, when `db.major_version > 14` — forces v9 compat if the tag contains `v9`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Files Written

| Path                                           | Format | When                                                                                                                                      |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | a remote project (`--remote`, `--remote=<ref>`, `--remote=<branch>` or an alias), via `LinkedProjectCache.cache`, when the file is absent |

The local target and `--remote=<db-url>` write no files.

## API Routes

| Method   | Path                                        | Auth         | Request body                              | Response (used fields)                                                                                                                                                                                                                        |
| -------- | ------------------------------------------- | ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/projects/{ref}/types/typescript`       | Bearer token | none                                      | TypeScript type definitions text                                                                                                                                                                                                              |
| `GET`    | `/v1/projects/{ref}`                        | Bearer token | none                                      | non-TypeScript lookup (`404` ⇒ branch ref); also the linked-project cache fill on every remote project                                                                                                                                        |
| `GET`    | `/v1/branches/{branch_id_or_ref}`           | Bearer token | none                                      | `db_host`, `db_port`, `db_user`, `db_pass`                                                                                                                                                                                                    |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }`                    | temporary `role` and `password`                                                                                                                                                                                                               |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string`                                                                                                                                                                                                            |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses`                                                                                                                                                                                                                       |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none                                                                                                                                                                                                                                          |
| `GET`    | `/v1/projects`                              | Bearer token | none                                      | project list for the ref prompt: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format                                                                       |
| `GET`    | `/v1/projects/{parent}/branches`            | Bearer token | none                                      | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or an alias given a branch name), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |

The TypeScript endpoint is called for a remote project (`--remote`, `--remote=<ref>`,
`--remote=<branch>` or an alias) when `--lang=typescript`. For other languages on a remote project
(see Notes), the project endpoint is probed first: a `404` means the ref is a preview branch (any
404 body), so the branch endpoint supplies the branch database host/port and credentials for the
direct connection. Otherwise the database connection is resolved for the ref and the login-role
endpoint supplies temporary credentials. On an IPv4-only network where the direct database host is
unreachable, remote project generation retries once through the IPv4 pooler only when the current
target host is the project's direct `db.<ref>` host and the pooler URL matches the expected tenant
and pooler domain. A ref given by flag (`--remote=<ref>`, `--remote=<branch>` or an alias), or one
that is not the workdir's linked project, fetches the primary pooler config for that ref to build
the fallback connection (the saved workdir `.temp/pooler-url` is ignored because the ref may differ
from the linked workdir). The network-ban calls happen only on project refs, from the third attempt
to connect as the temporary login role, and never for preview branches. `--remote=<branch>` resolves
the name to that branch's own project ref through the branch list before any of these calls. The
local target and `--remote=<db-url>` do not call the Management API.

## Subprocesses

| Command                                                      | When                                                                                                             | Purpose                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `docker`/`podman container inspect supabase_db_<project_id>` | the local target, only when the selected backend is the legacy Docker Compose stack (`[experimental].stack` off) | assert `supabase start` is running, against the shell-selected daemon (a project `.env*` is not forwarded to the spawn) |
| `dart run supabase_typegen --output -`                       | `--lang dart` on every target, in the directory the command was run from                                         | generate the types from the `GeneratorMetadata` JSON on stdin                                                           |

Any other `--lang` whose registry entry is out-of-process runs its own tool
the same way: stdout is the output, stderr is folded into the error on
failure. The tool inherits the CLI's entire environment, so a `PUB_CACHE` or
proxy setting reaches it unchanged. Introspection and the in-process
languages never shell out. On a native or Docker-based managed stack
(`[experimental].stack` on), the local target never inspects a container; it
resolves the stack's database connection through `DbConfigResolver` the same
way `--remote=<db-url>` does.

## Environment Variables

| Variable                                                                                                                                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Required?                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN`                                                                                                                                                                          | auth token for a remote project                                                                                                                                                                                                                                                                                                                                                                                                                                          | no (falls back to keyring → `~/.supabase/access-token`)                                                                                                                                                |
| `SUPABASE_PROJECT_ID`                                                                                                                                                                            | local Docker container and network project ID; the project ref of a bare `--remote`, and the parent project for `--remote=<branch>`                                                                                                                                                                                                                                                                                                                                      | no (falls back to the workdir name)                                                                                                                                                                    |
| `SUPABASE_DB_PORT`                                                                                                                                                                               | local database port                                                                                                                                                                                                                                                                                                                                                                                                                                                      | no (defaults to `54322`)                                                                                                                                                                               |
| `SUPABASE_DB_MAJOR_VERSION`                                                                                                                                                                      | local PostgreSQL major version                                                                                                                                                                                                                                                                                                                                                                                                                                           | no (defaults to `17`)                                                                                                                                                                                  |
| `SUPABASE_API_SCHEMAS`                                                                                                                                                                           | schemas used on every target (local, remote project, `--remote=<db-url>`) when `--schema` is omitted; wins over `[api].schemas`                                                                                                                                                                                                                                                                                                                                          | no (defaults to `public,graphql_public`)                                                                                                                                                               |
| `SUPABASE_ENV`                                                                                                                                                                                   | selects nested dotenv files for local generation and `--remote=<db-url>` resolution                                                                                                                                                                                                                                                                                                                                                                                      | no (defaults to `development`)                                                                                                                                                                         |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLPASSWORD`, `PGCONNECT_TIMEOUT`, `PGSERVICE`, `PGSERVICEFILE`, `PGAPPNAME` | libpq connection-setting fallbacks `--remote=<db-url>` consults for whatever the DSN itself omits                                                                                                                                                                                                                                                                                                                                                                        | no — each applies only when the DSN, a resolved `service`, and (where applicable) `[db].password` leave the setting unset                                                                              |
| `SUPABASE_PROFILE`                                                                                                                                                                               | built-in profile name or YAML file path                                                                                                                                                                                                                                                                                                                                                                                                                                  | no (falls back to `~/.supabase/profile` -> `supabase`)                                                                                                                                                 |
| `SUPABASE_DB_PASSWORD`                                                                                                                                                                           | database password for a remote project (shell env > project `.env*` > config); withheld, with a stderr `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN).` line, when the target differs from `.temp/project-ref`, which mints a temporary login role instead. **Not read by the local target**, which uses `[db].password` (default `postgres`) | no                                                                                                                                                                                                     |
| `SUPABASE_SERVICES_HOSTNAME`                                                                                                                                                                     | host used to reach the local database on the legacy Docker Compose stack; read from the shell env first, then project `.env*`                                                                                                                                                                                                                                                                                                                                            | no (defaults to the shell `DOCKER_HOST`'s tcp host, else `127.0.0.1`)                                                                                                                                  |
| `SUPABASE_WORKDIR`                                                                                                                                                                               | working directory `supabase/config.toml`/`config.json` is read from (`--workdir` takes priority)                                                                                                                                                                                                                                                                                                                                                                         | no — when unset, the CLI walks up from cwd looking for `supabase/config.toml` or `supabase/config.json`; when SET (flag or env) the directory is used exactly as given and **no ancestor is searched** |
| `PATH`, `PATHEXT`, `ComSpec`                                                                                                                                                                     | find the tool of an out-of-process `--lang`; `PATHEXT` and `ComSpec` matter on Windows only                                                                                                                                                                                                                                                                                                                                                                              | no (`PATHEXT` defaults to `.COM;.EXE;.BAT;.CMD`, `ComSpec` to `cmd.exe`; without `PATH` the tool is reported as not installed)                                                                         |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — types printed to stdout                                                                                                                                                                                                                                             |
| `1`  | conflicting target flags (see Notes): two selectors, `--project-ref` or `--project-id` combined with `--local`, `--db-url` or `--remote=<value>`, or `--project-id` combined with `--project-ref` (`TargetSelectorConflictError`, `TargetProjectRefConflictError`)            |
| `1`  | an empty `--db-url`, `--project-ref` or `--project-id` (`TargetEmptyValueError`), `--remote` switched off or given an empty value, or a bare `--remote` followed by a word that is a branch of the linked project (`TargetRemoteAmbiguousError`)                              |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist)                                                                                                                                                        |
| `1`  | a remote project selector (`--remote`, `--remote=<ref>`, `--remote=<branch>`, `--linked`, `--project-ref` or `--project-id`) combined with `--postgrest-v9-compat`, `--query-timeout` or a language flag (`GenTypesFlagUsageError`); `--remote=<db-url>` is outside the group |
| `1`  | `--postgrest-v9-compat` used without `--remote=<db-url>` or `--db-url` (`GenTypesFlagUsageError`)                                                                                                                                                                             |
| `1`  | a positional language other than `typescript` passed without `--lang` (`GenTypesFlagUsageError`)                                                                                                                                                                              |
| `1`  | invalid `--query-timeout` duration or invalid database URL                                                                                                                                                                                                                    |
| `1`  | `--network-id` set (`GenTypesNetworkIdUnsupportedError`) — generation runs in-process and cannot join a Docker network                                                                                                                                                        |
| `1`  | `supabase start` not running (local target on the legacy Docker Compose stack) (`GenTypesLocalDbNotRunningError`)                                                                                                                                                             |
| `1`  | the local target on the legacy Docker Compose stack and `container inspect` exits non-zero for any other reason (`GenTypesLocalDbInspectError`)                                                                                                                               |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`GenTypesWorkdirError`) — beats every other guard                                                                                                                                                 |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` holds no project config on a schema-selecting path (`GenTypesMissingProjectConfigError`) — a DEFAULTED workdir keeps the embedded-default fallback instead                                                                         |
| `1`  | a resolved preview branch config has no `db_user`/`db_pass` (`GenTypesBranchCredentialsUnavailableError`)                                                                                                                                                                     |
| `1`  | API error or database connection/introspection/generation failure (`GenTypesGenerationError`)                                                                                                                                                                                 |
| `1`  | an out-of-process language's toolchain or package is missing from the current directory; the message carries the registry's install hint (`GenTypesToolNotInstalledError`)                                                                                                    |
| `1`  | an out-of-process language's tool exited unsuccessfully or rejected the metadata document; the message carries its stderr (`GenTypesToolFailedError`)                                                                                                                         |

## Output

### `--output-format text`

Prints generated TypeScript (or other language) type definitions to stdout.
Diagnostics go to stderr: one `Target: …` banner naming the resolved target (the project
ref and whether its identity is verified, the local stack host and port, or the custom
Postgres host) and `Connecting to …` for database introspection. With the local default in a
linked directory the banner ends with `· default; pass --remote for <project>`. On the legacy Docker
Compose stack the banner prints before the running check, so a stopped stack still shows the chosen
target. In-process TypeScript also prints a stderr note that the output is unformatted.
Each deprecated selector additionally prints its warning on stderr, for example
`--project-id is deprecated and will be removed in v4. Use --remote instead: supabase gen types --remote=<ref>`.

### `--output-format json`

Not applicable. The output is the generated artifact, so no `target` field is added to it.

### `--output-format stream-json`

Not applicable.

## Notes

- TypeScript generated in-process is unformatted. stderr suggests `npx oxfmt <generated-file.ts>`.
  TypeScript for a remote project still comes from the Management API.
- **Target.** With no selector the command runs against the local database; when the directory is
  linked the local `Target:` banner ends with `· default; pass --remote for <project>`. `--remote`
  targets the linked project (`SUPABASE_PROJECT_ID`, else `.temp/project-ref`). `--remote=<value>`
  is read as a project ref (20 lowercase letters), a database URL (`postgres://` or
  `postgresql://`), `true|yes|on|1` (the linked project), or otherwise the name of a branch of the
  linked project, which resolves to that branch's own project. `false|no|off|0`, `--no-remote` and
  an empty value fail with `Leave out --remote to target the local database.` A bare `--remote`
  followed by a word that exactly matches a branch of the linked project, is within a small edit
  distance of one, or can't be checked because the branch listing failed stops the run with an error
  that offers both readings: `--remote=<word>` for the branch, `<word> --remote` for the operand.
  Any other word runs as the operand. The
  resolved target is announced on stderr (`Target: …`) in every output format.
- **Deprecated selectors.** `--linked`, `--project-ref`, `--project-id`, `--db-url` and `--local`
  are hidden aliases that still select their target and print a warning on stderr naming the
  replacement, for example
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase gen types --remote`,
  `--project-id is deprecated and will be removed in v4. Use --remote instead: supabase gen types --remote=<ref>`
  and `--local isn't needed (local is the default) and will be removed in v4: supabase gen types`; a
  database URL is never echoed. Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` and
  `--project-id` cannot be combined with `--local`, `--db-url` or `--remote=<value>`, an empty
  `--db-url`, `--project-ref` or `--project-id` is rejected, and `--linked=false` selects nothing.
  `--project-id` is an alias of `--project-ref`; passing both fails with
  `--project-id is a deprecated alias of --project-ref; pass only one of them.`
- **Remote project flag groups.** `--remote` (bare, or with a ref or branch), `--linked`,
  `--project-ref` and `--project-id` count as one member of each group
  `[remote linked project-ref <flag>]`, where `<flag>` is `postgrest-v9-compat`, `query-timeout` or a
  language flag (`swift-access-control`). Passing the selector together with any of them fails with
  `if any flags in the group [remote linked project-ref <flag>] are set none of the others can be; [<set flags, sorted>] were all set`,
  reporting the first violated group in that order. `--remote=<db-url>` and `--db-url` are not
  members, so they accept all three.
- With the local target, a missing `supabase/config.toml` uses the embedded config defaults plus
  shell and nested dotenv overrides, matching the CLI. The database password is the `[db].password`
  value (default `postgres`); `SUPABASE_DB_PASSWORD` has no effect, and the command has no
  `--password` flag.
- **Config value precedence** (ADR 0032): explicit flag > shell env > project `.env*` > config
  (`config.json` over `config.toml`; a matched `[remotes.*]` block over the base document on
  a remote project) > default. The whole config is decoded up front where it is loaded,
  so an invalid value fails the command.
- `--network-id` is rejected on this command: generation runs in-process over a direct
  PostgreSQL connection, and there is no container to join a Docker network from. Use a
  host-reachable `--remote=<db-url>` instead.
- **TLS.** There is no SSL probe on any path.
  - A remote project (including a resolved preview branch) connects with `sslmode=require` and the bundled Supabase CA pinned
    (promoted to `verify-ca`), matching prior behavior.
  - `--remote=<db-url>` honors the DSN's own `sslmode`/`sslrootcert` when either is set, even
    against a target classified local (e.g. a TLS tunnel on the loopback stack);
    otherwise, a known Supabase host gets the Supabase CA pinned the same way, and any
    other host — including a loopback target where the DSN sets neither — uses the
    connection resolver's default, which is plaintext for a local target.
  - The local target uses no TLS.
- **Remote project language generation.** `--lang` accepts `typescript` (default), `go`, `swift`, or
  `python`. A remote project uses the Management API for TypeScript, and connects directly to the
  project database (temporary login-role credentials, preview-branch fallback) for the other
  languages, so no database URL is required. Do not revert this to a hard error. The flag groups
  block `--swift-access-control`, `--query-timeout` and `--postgrest-v9-compat` whenever a remote
  project selector is passed, so a remote project always generates with defaults (`internal` access
  control, one-to-one detection on, 15s timeout). Use `--remote=<db-url>` for control over any of
  these three flags.
- **Output compatibility with the previous pg-meta-based generator.** Measured against
  pg-meta's reference generators on the same schema:
  - Go and Swift output is byte-identical to the reference generators.
  - TypeScript: a `NOT NULL` jsonb column now generates `NonNullable<Json>` instead of
    `Json` — the old type wrongly admitted `null` on a column the schema declares
    non-nullable.
  - Python: jsonb columns now generate `JsonValue` instead of pydantic's `Json[Any]`,
    which expected an unparsed JSON _string_ rather than the already-decoded row value
    typegen produces; `NotRequired` and `TypeAlias` are now imported from
    `typing_extensions` instead of `typing`.
  - TypeScript for a remote project is still generated server-side by the
    Management API and is unaffected by this change, so it can differ from local output
    on these jsonb cases until the hosted service adopts the same generator.
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- Language flags are rendered from the registry's user-facing option specs; today that is
  `--swift-access-control`, which accepts `internal` (default), `public`, `private` or `package`.
  Every such flag is mutually exclusive with a remote project selector; on the local and
  `--remote=<db-url>` paths the flags are parsed regardless of `--lang`, and only the values the
  chosen language declares reach its generator.
- `--postgrest-v9-compat` is deprecated and hidden from help and docs. It still turns
  one-to-one relationship detection off (the registry's `detect-one-to-one-relationships`
  consumer option), must be used together with `--remote=<db-url>` (or `--db-url`) (error:
  `--postgrest-v9-compat must used together with --remote=<db-url>` — note the typo, preserved
  intentionally), and prints this line on stderr when passed:

  ```
  Flag --postgrest-v9-compat has been deprecated, PostgREST 9 reached end of life; the flag still disables one-to-one relationship detection.
  ```

  The local target still forces detection off when the local PostgREST image tag contains `v9`.

- `--query-timeout` sets the maximum time allowed for introspection (default 15s), applied both as
  the connection's server-side `statement_timeout` and as a connect timeout. It is mutually
  exclusive with a remote project selector; on the local and `--remote=<db-url>` paths it is
  accepted and applied for every language that connects to the database.
- The legacy positional language argument (`supabase gen types typescript`) is still accepted;
  any other positional language requires an explicit `--lang` flag.
- The linked-project telemetry cache is written only when a remote project resolves a project ref —
  it's skipped for the local target and `--remote=<db-url>`.
- Telemetry records a `--project-ref` or `--project-id` value only when it is a 20-letter project
  ref; a branch name is never recorded.
