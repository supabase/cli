# `supabase backups restore`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)            |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set                                |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | after the command runs (in `Effect.ensuring`), unless the file already exists, `.temp/project-ref` names a different project, no access token resolves, or the project lookup is not 200 |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                          |

## API Routes

| Method | Path                                               | Auth         | Request body                         | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------------------------- | ------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/projects/{ref}/database/backups/restore-pitr` | Bearer token | `{recovery_time_target_unix: int64}` | none (201 Created)                                                                                                                                                                                                                                       |
| `GET`  | `/v1/projects`                                     | Bearer token | none                                 | `[{id, ref, name, organization_slug, region, ...}]` — TTY-prompt fallback only                                                                                                                                                                           |
| `GET`  | `/v1/projects/{ref}`                               | Bearer token | none                                 | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, after the command)                                                                                                                                      |
| `GET`  | `/v1/projects/{parent}/branches`                   | Bearer token | none                                 | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                  | Required?                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                     | no (falls back to keyring → `~/.supabase/access-token`)                             |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is not given                                                                                                                                                                                                                                  | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY)          |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                        | no (walks up from CWD looking for `supabase/config.toml` or `supabase/config.json`) |
| `SUPABASE_YES`          | approves the hosted-mutation confirmation like `--yes` (shell environment only; `supabase/.env` is ignored)                                                                                                                                                                              | no                                                                                  |

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — restore initiated                                                                                            |
| `1`  | `AccessTokenRequiredError` — no token in env/keyring/file                                                              |
| `1`  | `InvalidAccessTokenError` — token violates `^sbp_(oauth_\|v0_)?[a-f0-9]{40}$`                                          |
| `1`  | `ProjectRefNotLinkedError` — no `--remote=<ref>`, env/file empty, and stdin not a TTY                                  |
| `1`  | `InvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                                                         |
| `1`  | `BackupRestoreUnexpectedStatusError` — non-201 response from the restore endpoint                                      |
| `1`  | `BackupRestoreNetworkError` — transport-level network failure                                                          |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                             |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote=<ref>` → the ref, a bare `--remote` → `true`, any other `--remote` value → `<redacted>`; `--project-ref` / `--timestamp` → `<redacted>`) |

## Output

This command ignores `--output` entirely and always writes the success line to
**stderr**, for every `--output` value. The `--output-format` JSON modes get a
structured payload.

### `--output pretty|yaml|toml|env` / `--output-format text`

Writes `"Started PITR restore: <ref>\n"` to **stderr**.

### `--output json`

Indented JSON object on stdout: `{ "message": "Started PITR restore", "project_ref": "<ref>" }`.

### `--output-format json`

Single JSON success event via `Output.success("Started PITR restore", { project_ref })`.

### `--output-format stream-json`

One `result` NDJSON event on success with the project ref payload.

## Notes

- Targets the linked project unless `--remote=<ref>` is given; a bare `--remote` also targets the linked project. `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked project (by name or UUID, resolved through `GET /v1/projects/{parent}/branches`), or `true|yes|on|1` for the linked project. A database URL is rejected (`supabase backups restore` takes a project, not a database); `false|no|off|0`, `--no-remote` and an empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that is a branch of the linked project fails before any other work with a `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` and prints a deprecation warning on stderr that names the replacement; it cannot be combined with `--remote=<value>`. An empty `--project-ref` is rejected.
- `--timestamp` / `-t` accepts seconds since Unix epoch (int64). Defaults to `0`, which the API interprets as "now".
- Known gap: the generated `V1RestorePitrBackupInput` schema enforces `recovery_time_target_unix >= 0`, so a negative value is rejected locally with a schema decode error instead of being forwarded to the API (the underlying field has no lower bound). Resolving this requires an upstream OpenAPI spec change.
- Requires `--remote=<ref>`, `SUPABASE_PROJECT_ID`, a populated `<workdir>/supabase/.temp/project-ref` file, or a TTY for the interactive project picker.
- The interactive picker calls `GET /v1/projects` and writes `"Selected project: <ref>"` to stderr in text mode. It does **not** persist the choice; only `supabase link` and `supabase bootstrap` write the temp file.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.

- Prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged.
- **Consent.** Asks once, after the project is resolved and before the POST, with default No: `Restore the database to Unix timestamp <t> (PITR)`. With no `--timestamp` the action reads `Start a PITR restore without a recovery time target`. `--yes` or a shell `SUPABASE_YES` approves it (`supabase/.env` does not) and echoes `Confirmed by --yes: <action> on <target>` to stderr. Without it, only an interactive text-mode terminal is asked: JSON, `-o`, piped and agent runs exit 1 with `HostedMutationConsentRequiredError` and change nothing, and declining exits 1 with `HostedMutationDeclinedError`. Stdin is never read.
