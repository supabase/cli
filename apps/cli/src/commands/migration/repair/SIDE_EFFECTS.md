# `supabase migration repair`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always, for the `[db]` settings, with a matched `[remotes.<ref>]` block over the base for a remote project (flag > shell env > project `.env*` > config)                               |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                            |
| `<workdir>/supabase/migrations/`               | directory  | `--status applied` (the matching file per version) and repair-all (every local version), before connecting                                                                             |

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
| `GET`    | `/v1/branches/{id}`                         | Bearer token | none                                      | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                                         |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }`                    | temporary `role` and `password` — remote project with no database password                                                                                                                                                                                               |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string` — remote project on an IPv4-only network (direct host unreachable), only when the ref came from `--remote=<ref>` or `--remote=<branch>`, or differs from the linked project; a differing ref ignores the saved `.temp/pooler-url`     |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses` — remote project, from the 3rd failed temporary-role connect                                                                                                                                                                                     |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none — remote project, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clears every listed address); otherwise the connect keeps retrying and fails with `LinkedDbNetworkBannedError` once the retries run out                                   |
| `GET`    | `/v1/projects/{ref}`                        | Bearer token | none                                      | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, post-run): written only when `.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |

## Environment Variables

| Variable                | Purpose                                                                                    | Required?                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for a remote project                                                            | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the remote project's database connection (`--password`/`-p` takes precedence) | no                                                      |
| `SUPABASE_PROJECT_ID`   | project ref for a bare `--remote`, and the parent project for `--remote=<branch>`          | no                                                      |
| `SUPABASE_YES`          | confirms a hosted repair when exported in the shell (the project `.env` does not count)    | no                                                      |

## Exit Codes

| Code | Condition                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                          |
| `1`  | database connection failure                                                                      |
| `1`  | invalid or missing `--status` flag                                                               |
| `1`  | a version's local migration file is missing (`--status applied`)                                 |
| `1`  | hosted target without `--yes` in a run that cannot prompt (`HostedMutationConsentRequiredError`) |
| `1`  | hosted confirmation declined (`context canceled`)                                                |

## Output

### `--output-format text`

Prints `Target: …` to stderr first. When repairing specific versions, prints `Repaired migration history: [<versions>]
=> <status>` to stderr, then `Finished supabase migration repair.` to stdout and
the suggestion `Run supabase migration list to show the updated migration history.`
to stderr; the suggestion carries the flags that select the repaired hosted target
(`--remote`, `--remote=<ref>`), so it lists the same database. The DB work is the history-table provisioning (its own transaction,
skipped entirely when a read-only probe finds the ledger already provisioned, so a
provisioned remote runs no provisioning DDL — supabase/cli#6393) followed by one
repair transaction: (for repair-all) `TRUNCATE`, plus `applied` → per-version
`UPSERT` from the local file, `reverted` → `DELETE ... WHERE version = ANY($1)`.

> **Atomicity note:** the TRUNCATE/UPSERT/DELETE statements run in an explicit
> `BEGIN`/`COMMIT` with `ROLLBACK` on error, so a partial failure (e.g. TRUNCATE
> succeeds but a later UPSERT fails) leaves the table unchanged. This handler keeps
> that transaction instead of using the migration apply path's batch primitive.

### `--output-format json`

Emits `output.success("Migration history repaired", { versions, status, repairAll })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- A hosted target (a remote project or a non-local database URL) asks once, after the versions and
  local files are resolved and before the history table is created or changed. The plan lists
  each version (`Mark <n> migrations as <status>`), or for repair-all the table replacement or
  clearing. The default is **NO**. Declining exits
  1 (`context canceled`) and changes nothing.
- A local target never prompts, including repair-all.

## Notes

- `--status` flag is required and accepts `applied` or `reverted`.
- Accepts zero or more migration version arguments; each must be numeric
  (`failed to parse <v>: invalid version number` otherwise). Zero versions enables
  repair-all.
- In `applied` mode, reads the matching `supabase/migrations/<version>_*.sql` file
  for the name + statements before connecting; a missing file exits non-zero without touching the
  database.
- **`--password`.** For a remote project the password resolves as flag > shell `SUPABASE_DB_PASSWORD` >
  project `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr
  `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`),
  and a temporary login role is minted instead (ADR 0032).
