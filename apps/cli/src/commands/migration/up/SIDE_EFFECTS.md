# `supabase migration up`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`               | directory  | always, to read pending migration files                                                                                                                                                |
| `<workdir>/supabase/config.toml`               | TOML       | always, for the `[db]` settings, with a matched `[remotes.<ref>]` block over the base for a remote project (flag > shell env > project `.env*` > config)                               |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
| `PGSSL*` PEM, `pg_service.conf`                | PEM, libpq | remote project, when set; see `db push`                                                                                                                                                |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                            |

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
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string` — remote project on an IPv4-only network (direct host unreachable), only when there is no usable saved `.temp/pooler-url` and an access token is available; a ref that differs from the linked project ignores the saved URL          |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses` — remote project, from the 3rd failed temporary-role connect                                                                                                                                                                                     |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none — remote project, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clears every listed address); otherwise the connect keeps retrying and fails with `LinkedDbNetworkBannedError` once the retries run out                                   |
| `GET`    | `/v1/projects/{ref}`                        | Bearer token | none                                      | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, post-run): written only when `.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |

## Environment Variables

| Variable                 | Purpose                                                                              | Required?                                               |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`  | auth token for a remote project                                                      | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`    | project ref for a bare `--remote`, and the parent project for `--remote=<branch>`    | no                                                      |
| `SUPABASE_YES`           | confirms a hosted run when exported in the shell (the project `.env` does not count) | no                                                      |
| `DOTENV_PRIVATE_KEY[_*]` | dotenvx private key(s) to decrypt `encrypted:` `[db.vault]` secrets before upsert    | no (required only if a `[db.vault]` value is encrypted) |
| `PG*` libpq              | remote-project TLS, timeout, service; see `db push`                                  | no                                                      |

## Exit Codes

| Code | Condition                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                          |
| `1`  | database connection failure                                                                      |
| `1`  | migration SQL execution error                                                                    |
| `1`  | hosted target without `--yes` in a run that cannot prompt (`HostedMutationConsentRequiredError`) |
| `1`  | hosted confirmation declined (`context canceled`)                                                |

## Output

### `--output-format text`

Prints `Target: …` to stderr, then `Applying migration <file>...` per pending migration, then
`Local database is up to date.` (`Remote database is up to date.` for a non-local target) to
stdout. Connects, lists remote + local
migrations, computes the pending set, upserts `[db.vault]` secrets, and applies
each pending migration transactionally. Does **not** seed.

### `--output-format json`

Emits `output.success("Migrations applied", { applied: [<path>] })`.

### `--output-format stream-json`

Same structured `applied` result delivered as an NDJSON `result` event.

## Prompts

- A hosted target (a remote project or a non-local database URL) asks once, after the pending set
  is computed and before the first SQL or vault write, listing each migration to apply and the
  vault secrets to update (default **NO**). Nothing is asked when there is nothing to apply. Declining exits 1 (`context canceled`).
- A local target never prompts.

## Notes

- `--include-all` applies all migrations not found on the remote history table.
- Pipeline-incompatible statements (`CREATE [UNIQUE] INDEX CONCURRENTLY`,
  `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CLUSTER`) run standalone outside
  the migration's transaction batch — they fail with SQLSTATE 25001 inside one. The
  history insert stays in the final batch, so a mid-file failure leaves earlier,
  already-committed batches applied with **no history row**; a re-run replays the file
  from the top. Prefer idempotent forms (`… IF NOT EXISTS`) for such statements.
  Intentional fix for supabase/cli#5139, adopted into TS in PR supabase/cli#5671
  (landed on develop as `b48fad60`).
