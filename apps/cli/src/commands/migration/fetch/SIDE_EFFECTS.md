# `supabase migration fetch`

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always, for the `[db]` settings, with a matched `[remotes.<ref>]` block over the base for a remote project (flag > shell env > project `.env*` > config)                               |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                            |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | always, to resolve `SUPABASE_YES` for the overwrite prompt                                                                                                                             |

## Files Written

| Path                                                 | Format   | When                                                                                                  |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<version>_<name>.sql` | SQL text | writes fetched migration files locally; the directory is created only after the history table is read |
| `<workdir>/supabase/.temp/linked-project.json`       | JSON     | remote project, on completion — caches the project identity                                           |

## API Routes

Local targets and database URLs make none.

| Method   | Path                                        | Auth         | Request body                              | Response (used fields)                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`                              | Bearer token | none                                      | `[{id, name, organization_slug, region}]` — project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format                                                                       |
| `GET`    | `/v1/projects/{parent}/branches`            | Bearer token | none                                      | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                 |
| `GET`    | `/v1/branches/{id}`                         | Bearer token | none                                      | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                                         |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }`                    | temporary `role` and `password` — remote project with no database password                                                                                                                                                                                               |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string` — remote project on an IPv4-only network (direct host unreachable), only when the ref came from `--remote=<ref>` or `--remote=<branch>`, or differs from the linked project; a differing ref ignores the saved `.temp/pooler-url`     |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses` — remote project, from the 3rd failed temporary-role connect                                                                                                                                                                                     |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none — remote project, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clears every listed address); otherwise the connect keeps retrying and fails with `LinkedDbNetworkBannedError` once the retries run out                                   |
| `GET`    | `/v1/projects/{ref}`                        | Bearer token | none                                      | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, post-run): written only when `.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |

## Environment Variables

| Variable                | Purpose                                                                           | Required?                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for a remote project                                                   | no (falls back to keyring → `~/.supabase/access-token`)                                                 |
| `SUPABASE_PROJECT_ID`   | project ref for a bare `--remote`, and the parent project for `--remote=<branch>` | no                                                                                                      |
| `SUPABASE_YES`          | auto-confirm the overwrite prompt                                                 | no — read from the shell env OR the project `.env`/`.env.local`/`.env.<env>[.local]` files (shell wins) |

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                |
| `1`  | database connection failure                                                                                            |
| `1`  | failed to write migration files                                                                                        |
| `1`  | conflicting target selectors (see Notes)                                                                               |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist) |

## Output

### `--output-format text`

Prints one `Target: …` line on stderr naming the resolved database, then is silent on success. Reads
`SELECT version, coalesce(name, '') as name, statements FROM
supabase_migrations.schema_migrations` and writes each row to
`<workdir>/supabase/migrations/<version>_<name>.sql` (statements joined with
`;\n` plus a trailing `;\n`, mode 0644).

### `--output-format json`

Emits `output.success("Migration history fetched", { files: [<absolute path>] })`, with the resolved `target` merged in.

### `--output-format stream-json`

Same structured `files` result delivered as an NDJSON `result` event.

## Prompts

- When the migrations directory is non-empty, prompts
  `Overwrite local migrations with the history from <target>?`, where `<target>` is the
  announced target (`Target: …`), e.g. `local stack (127.0.0.1:54322)` (default **YES**). Declining exits non-zero (`context canceled`). `--yes` or
  `SUPABASE_YES` (shell env or project `.env`) auto-confirms; a non-interactive /
  machine-output run takes the default (YES). An unrecognised answer declines. This is a
  prompt about local files, so a `SUPABASE_YES` in the project `.env` still answers it.
- The command only reads the remote history, so it asks for no hosted-mutation consent.
  `--yes` (or a shell `SUPABASE_YES`) additionally lets the connection remove a network ban
  that blocks the temporary login role.

## Notes

- **Target.** With no selector the command runs against the local database; when the directory is
  linked the local `Target:` banner ends with `· default; pass --remote for <project>`. `--remote`
  targets the linked project (`SUPABASE_PROJECT_ID`, else `.temp/project-ref`). `--remote=<value>`
  is read as a project ref (20 lowercase letters), a database URL (`postgres://` or
  `postgresql://`), `true|yes|on|1` (the linked project), or otherwise the name of a branch of the
  linked project, which resolves to that branch's own project. `false|no|off|0`, `--no-remote` and
  an empty value fail with `Leave out --remote to target the local database.` A word after a bare
  `--remote` is read as its value, `--remote=<word>`, because the command takes no operands. The
  resolved target is announced on stderr (`Target: …`) in every output format and, in JSON results,
  as a `target` object.
- **Deprecated selectors.** `--linked`, `--project-ref`, `--db-url` and `--local` are hidden aliases
  that still select their target and print a warning on stderr naming the replacement, for example
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase migration fetch --remote`
  and
  `--local isn't needed (local is the default) and will be removed in v4: supabase migration fetch`;
  a database URL is never echoed. Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` cannot
  be combined with `--local`, `--db-url` or `--remote=<value>`, an empty `--db-url` or
  `--project-ref` is rejected, and `--linked=false` selects nothing.
- Fetches migration file contents from the `supabase_migrations.schema_migrations` history table.
- **Empty-statements rows:** a row whose `statements` array is empty
  (NULL/`{}` — possible on older projects or manually-inserted rows) is written as
  exactly `;\n`, not an empty file.
- **Path-traversal hardening :** before writing, each row's `version`/`name`
  is validated (`version` is all digits; `name` has no `/`, `\`, or `..` segment).
  A tampered/hostile remote could otherwise supply separators to escape the
  migrations directory (CWE-22). This is a new check with no effect on legitimate
  rows (real versions are digits and names are sanitized file stems); it
  fails with `failed to write migration: invalid version/name in history table`.
