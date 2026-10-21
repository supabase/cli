# `supabase migration down`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`               | directory  | always, to read migration files                                                                                                                                                        |
| `<workdir>/supabase/config.toml`               | TOML       | always, for the `[db]` settings, with a matched `[remotes.<ref>]` block over the base for a remote project (flag > shell env > project `.env*` > config)                               |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
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

Prints `Target: …` to stderr, then `Resetting database to version: <version>`, then drops every
user schema/object (the embedded `dropObjectsSql` DO-block), upserts `[db.vault]`
secrets, and re-applies local migrations `<= version` plus seed files (each gated
on `db.migrations.enabled` / `db.seed.enabled`). Nothing is written to stdout.

### `--output-format json`

Emits `output.success("Migrations reverted", { version, last })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- A hosted target (a remote project or a non-local database URL) asks once, after the migrations
  to revert are known and before the first drop or write: it lists the bulleted versions and a
  yellow `WARNING:` line, then asks `Reset the database to version <version> on <target>?`
  (default **NO**). Declining exits 1
  (`context canceled`).
- A local target never prompts.

## Notes

- `--last` (default 1) resets up to the last n migration versions; must be `> 0`
  and `<` the number of applied migrations. The error's `Try supabase db reset …`
  suggestion carries the flags that select a hosted target (`--remote`, `--remote=<ref>`).
- Takes no positional arguments.
- Performs no best-effort migrations-catalog cache optimization.
- Dotenvx-encrypted (`encrypted:`) `[db.vault]` values are decrypted during config
  load using `DOTENV_PRIVATE_KEY[_*]`; an `encrypted:` value with no working key
  aborts the command with `failed to parse config: …`.
