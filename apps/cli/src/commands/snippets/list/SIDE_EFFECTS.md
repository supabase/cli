# `supabase snippets list`

## Files Read

| Path                                           | Format                    | When                                                                                                            |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                   |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                        |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                                   |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are unset, and as the linked parent for `--remote=<branch>` |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                                  |

## Files Written

| Path                                           | Format | When                                             |
| ---------------------------------------------- | ------ | ------------------------------------------------ |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`) |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after the project ref resolves       |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `GET`  | `/v1/snippets?project_ref=<ref>` | Bearer token | none         | `{data: [{id, name, visibility, owner: {username}, inserted_at, updated_at, ...}], cursor?}`                                                                                                                                                             |

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                      | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`)         |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)                                                                        | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                |
| `1`  | `SnippetsEnvNotSupportedError` — `--output env` was requested                                                                                                                                                          |
| `1`  | `ProjectRefNotLinkedError`; `InvalidProjectRefError` for a malformed `SUPABASE_PROJECT_ID` or link-file ref                                                                                                            |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | `SnippetsListUnexpectedStatusError` — non-2xx response                                                                                                                                                                 |
| `1`  | `SnippetsListNetworkError` — transport-level failure                                                                                                                                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                                                                                                       |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`) |

## Output

### `--output-format text` / `--output pretty`

styled ASCII table with columns `ID`, `NAME`, `VISIBILITY`, `OWNER`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`. Literal `|` characters in `name`, `visibility`, or `owner.username` are passed through verbatim in the final ASCII bytes (escaped internally during markdown rendering, then decoded back).

API-supplied strings are not stripped of ANSI / terminal control sequences before rendering.

```
  ID           | NAME         | VISIBILITY | OWNER    | CREATED AT (UTC)    | UPDATED AT (UTC)
  --------------|--------------|------------|----------|---------------------|---------------------
  test-snippet | Create table | user       | supaseed | 2023-10-13 17:48:58 | 2023-10-13 17:48:58
```

### `--output json`

Indented JSON with alphabetically-sorted keys and a trailing newline. Empty `data` is rendered as `null` (not an empty array).

```json
{
  "data": [
    { "favorite": false, "id": "…", "inserted_at": "…", "name": "…", "owner": { … }, ... }
  ]
}
```

### `--output yaml`

YAML rendering of the full `V1ListAllSnippetsOutput` response.

### `--output toml`

TOML rendering of the full `V1ListAllSnippetsOutput` response, with a trailing newline.

### `--output env`

Not supported — fails with `--output env flag is not supported`.

### `--output-format json` (TS extension)

Single `success` event whose `data` is the full `V1ListAllSnippetsOutput` payload.

### `--output-format stream-json` (TS extension)

NDJSON `success` event with the full response as `data`.

## Notes

- When both `--output` and `--output-format` are set, `--output` wins (matches the precedence used elsewhere in ports).
- `--output env` is rejected **after** project-ref resolution but **before** the API call.
- The linked-project cache fires after project-ref resolves; the telemetry state always flushes. Both run on success and on every error path via the two `Effect.ensuring` blocks in the handler.
- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase snippets list` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes
  no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
