# `supabase migration list`

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always, for the `[db]` settings, with a matched `[remotes.<ref>]` block over the base for a remote project (flag > shell env > project `.env*` > config)                               |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                            |
| `<workdir>/supabase/migrations/`               | directory  | always, to list local migration files                                                                                                                                                  |

## Files Written

| Path                                           | Format | When                                                        |
| ---------------------------------------------- | ------ | ----------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | remote project, on completion — caches the project identity |

## API Routes

Local targets and database URLs make none.

| Method   | Path                                        | Auth         | Request body                              | Response (used fields)                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`                              | Bearer token | none                                      | `[{id, name, organization_slug, region}]` — project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format                                                                       |
| `GET`    | `/v1/projects/{parent}/branches`            | Bearer token | none                                      | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                 |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }`                    | temporary `role` and `password` — remote project with no database password                                                                                                                                                                                               |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string` — remote project on an IPv4-only network (direct host unreachable), only when the ref came from `--remote=<ref>` or `--remote=<branch>`, or differs from the linked project; a differing ref ignores the saved `.temp/pooler-url`     |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses` — remote project, from the 3rd failed temporary-role connect                                                                                                                                                                                     |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none — remote project, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clears every listed address); otherwise the connect keeps retrying and fails with `LinkedDbNetworkBannedError` once the retries run out                                   |
| `GET`    | `/v1/projects/{ref}`                        | Bearer token | none                                      | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, post-run): written only when `.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |

## Environment Variables

| Variable                | Purpose                                                                           | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for a remote project                                                   | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the remote project's database connection (`--password`/`-p` wins)    | no                                                      |
| `SUPABASE_PROJECT_ID`   | project ref for a bare `--remote`, and the parent project for `--remote=<branch>` | no                                                      |

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                |
| `1`  | database connection failure                                                                                            |
| `1`  | `--password` with a local target or `--remote=<db-url>`                                                                |
| `1`  | failed to open migrations directory                                                                                    |
| `1`  | conflicting target selectors (see Notes)                                                                               |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist) |

## Output

### `--output-format text`

Prints `Target: …` to stderr first, then an ASCII table `|Local|Remote|Time (UTC)|` to stdout (cells are backtick-wrapped inline code). The database column is headed `Remote` for a remote project or a database URL and `Local DB` for the local database. Queries `SELECT version FROM
supabase_migrations.schema_migrations ORDER BY version` (a missing table → empty
database column).

### `--output-format json`

Emits `output.success("Migrations listed", { migrations: [{ local, remote, time }] })`.
`local`/`remote` are empty strings when a version exists only on the other side.

### `--output-format stream-json`

Same structured `migrations` result delivered as an NDJSON `result` event.

## Notes

- **Target.** With no selector the command runs against the local database; when the directory is
  linked the local `Target:` banner ends with `· default; pass --remote for <project>`. `--remote`
  targets the linked project (`SUPABASE_PROJECT_ID`, else `.temp/project-ref`). `--remote=<value>`
  is read as a project ref (20 lowercase letters), a database URL (`postgres://` or
  `postgresql://`), `true|yes|on|1` (the linked project), or otherwise the name of a branch of the
  linked project, which resolves to that branch's own project. `false|no|off|0`, `--no-remote` and
  an empty value fail with `Leave out --remote to target the local database.` A bare `--remote`
  followed by a word that is a branch of the linked project fails with a
  `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value. The
  resolved target is announced on stderr (`Target: …`) in every output format and, in JSON results,
  as a `target` object.
- **Deprecated selectors.** `--linked`, `--project-ref`, `--db-url` and `--local` are hidden aliases
  that still select their target and print a warning on stderr naming the replacement, for example
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase migration list --remote`
  and
  `--local isn't needed (local is the default) and will be removed in v4: supabase migration list`;
  a database URL is never echoed. Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` cannot
  be combined with `--local`, `--db-url` or `--remote=<value>`, an empty `--db-url` or
  `--project-ref` is rejected, and `--linked=false` selects nothing.
- Listing is a read: it never asks for confirmation, on any target.
- **`--password`** applies only to a remote project. With `--remote=<db-url>` (or `--db-url`) it
  fails with
  `--password can't be used with --remote=<db-url>. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres`;
  with a local target it fails with
  `--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.`
  followed by `To use the linked project instead, pass --remote.` when the directory is linked (exit
  1). For a remote project the password resolves as flag > shell `SUPABASE_DB_PASSWORD` > project
  `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr
  `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`),
  and a temporary login role is minted instead (ADR 0032).
