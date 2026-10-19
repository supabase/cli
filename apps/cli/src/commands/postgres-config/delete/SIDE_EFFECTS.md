# `supabase postgres-config delete`

## Files Read

| Path                                           | Format                    | When                                                                                                                                                               |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                         |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write                                                          |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are both unset, and as the linked parent for `--remote=<branch>`; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` - on success and failure. Not written if the gate is closed.                                                                                                                                             |

## API Routes

| Method | Path                                          | Auth         | Request body                                                    | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------- | ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                                | Bearer token | none                                                            | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`  | `/v1/projects/{parent}/branches`              | Bearer token | none                                                            | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none                                                            | full JSON object                                                                                                                                                                                                                                         |
| `PUT`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | current config minus deleted keys (`restart_database` optional) | full JSON object                                                                                                                                                                                                                                         |
| `GET`  | `/v1/projects/{ref}`                          | Bearer token | none                                                            | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |

This command does not call a delete endpoint: it fetches the current config, removes the specified keys locally, then sends the remaining object back via `PUT`.

The remaining stored overrides are forwarded unvalidated, so a stored key this CLI version does not know is preserved. The `PUT` is sent once and never retried, since a retried `restart_database` write could restart the database twice, and its response is read as a raw JSON object so every returned key is shown.

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                      | no (falls back to keyring -> `~/.supabase/access-token`)                                      |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                                   | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag                                                                  | no (pass `--experimental` instead; one of the two is required)                                |
| `SUPABASE_YES`          | confirms the hosted mutation without asking; only the shell environment counts, never `supabase/.env`                     | no (falls back to the interactive prompt)                                                     |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success - Postgres config updated with the deleted keys removed                                                                                                                                                                                                                                                                                                      |
| `1`  | malformed CSV in a `--config` value — fails during flag parsing, before the `--experimental` gate, the handler, and telemetry, with the exact diagnostic text on stderr (e.g. `invalid argument "\"max_connections" for "--config" flag: parse error on line 1, column 17: extraneous or missing " in quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) - checked before ref resolution/API/telemetry                                                                                                                                                                                                                            |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError`; `InvalidProjectRefError` for a malformed `SUPABASE_PROJECT_ID` or link-file ref)                                                                                                                                                                                                                                 |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`)                                                                                                                                                       |
| `1`  | initial GET non-2xx (`PostgresConfigGetUnexpectedStatusError`)                                                                                                                                                                                                                                                                                                       |
| `1`  | initial GET transport failure (`PostgresConfigGetNetworkError`)                                                                                                                                                                                                                                                                                                      |
| `1`  | PUT non-2xx (`PostgresConfigDeleteUnexpectedStatusError`)                                                                                                                                                                                                                                                                                                            |
| `1`  | PUT transport failure (`PostgresConfigDeleteNetworkError`); the GET retries on 5xx and transport errors first, the PUT does not                                                                                                                                                                                                                                      |
| `1`  | GET body is not a JSON object (`PostgresConfigGetUnmarshalError`); PUT 2xx body is not a JSON object (`PostgresConfigDeleteUnmarshalError`)                                                                                                                                                                                                                          |
| `1`  | declined at the confirmation prompt (`HostedMutationDeclinedError`, `context canceled`) — nothing is changed                                                                                                                                                                                                                                                         |
| `1`  | JSON, stream-json, `-o` or non-interactive run without `--yes` (`HostedMutationConsentRequiredError`) — nothing is changed                                                                                                                                                                                                                                           |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → `<redacted>`) |

## Output

Matches `get` on success: stderr headings plus the rendered table for the remaining config.

### `--output-format text` (default)

Renders the remaining config map as an ASCII table.

### `--output pretty`

Identical to text mode.

### `--output json`

Indented JSON of the remaining config object.

### `--output yaml`

YAML representation of the remaining config object.

### `--output toml`

TOML representation of the remaining config object.

### `--output env`

Flat `KEY="value"` lines for the remaining config object.

### `--output-format json`

Single `success` event whose data is the remaining config object.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- The `--output` flag wins over `--output-format` when both are provided.
- Flags: `--config` (repeatable, config keys to delete), `--no-restart`.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- Each config key is trimmed of whitespace before deletion.
- `--no-restart` injects `restart_database = false` into the final `PUT` body.
- `.temp/linked-project.json` is written after ref resolution (once the `--experimental` gate is open), even when the API call fails, but only on a cache miss with a token when `GET /v1/projects/{ref}` succeeds and `.temp/project-ref` does not name another ref. A closed gate writes nothing.
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- `postgres-config` is an experimental command: `delete` requires `--experimental`
  (or `SUPABASE_EXPERIMENTAL`), checked before the login check. A closed gate exits 1
  before project-ref resolution, the API calls, the `linked-project.json` write, the
  `telemetry.json` write, and the `cli_command_executed` event.
- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- Asks `Delete Postgres config overrides on <target>?` (default No) before the first write, after printing the keys to delete and whether the restart is skipped. `--yes` or a shell `SUPABASE_YES` confirms without asking; a piped `y` on stdin is never read. Without `--yes`, a non-interactive, JSON, stream-json or `-o` run fails with `HostedMutationConsentRequiredError`, and declining fails with `HostedMutationDeclinedError`; neither changes anything.
- The current overrides are fetched (a read) before the confirmation so the plan is known; the `PUT` happens only after it.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase postgres-config delete` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that is a branch of the linked project fails before any
  other work with a `Did you mean --remote=<word>?` hint, since the word may have been meant as
  the flag's value.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
