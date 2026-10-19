# `supabase snippets download`

## Files Read

| Path                                           | Format                    | When                                                                                                            |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                   |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                        |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                                   |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are unset, and as the linked parent for `--remote=<branch>` |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                                  |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                                                                                                                                         |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after the project ref resolves — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/snippets/{id}`              | Bearer token | none         | `{content: {sql, schema_version, favorite?}, id, name, visibility, owner, project, inserted_at, updated_at}`                                                                                                                                             |
| `GET`  | `/v1/projects`                   | Bearer token | none         | project picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, stdin is a TTY and output is interactive                                                                                                    |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `GET`  | `/v1/projects/{ref}`             | Bearer token | none         | linked-project cache fill — best-effort, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored                                                            |

Only `content.sql` is rendered in text mode. The full payload is exposed via `--output-format json`.

The snippet request carries no project ref and no query. The ref is resolved only so the cache fill can run, so the command still fails when no project is linked.

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                      | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`)         |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)                                                                        | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — SQL written to stdout                                                                                                                                                                                        |
| `1`  | `SnippetsInvalidIdError` — `<snippet-id>` is not a valid UUID                                                                                                                                                          |
| `1`  | `ProjectRefNotLinkedError`; `InvalidProjectRefError` for a malformed `SUPABASE_PROJECT_ID` or link-file ref                                                                                                            |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | `SnippetsDownloadUnexpectedStatusError` — non-2xx response                                                                                                                                                             |
| `1`  | `SnippetsDownloadNetworkError` — transport-level failure                                                                                                                                                               |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                                                                                                       |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`) |

## Output

### `--output-format text`

The raw SQL `content.sql` followed by a trailing `\n`.

```
select 1;
```

### `--output-format json` (TS extension)

Single `success` event with the full `V1GetASnippetOutput` payload as `data`. This includes `id`, `name`, `visibility`, `owner`, `project`, `inserted_at`, `updated_at`, `favorite`, and `content` (with `sql`, `schema_version`, and optional `favorite`). Agents that only need the SQL can read `data.content.sql`; agents reconstructing a snippet in a new project have everything they need.

```json
{
  "id": "0b0d48f6-…",
  "name": "Create table",
  "visibility": "user",
  "owner": { "id": 7, "username": "supaseed" },
  "content": { "schema_version": "1.0.0", "sql": "select 1;" }
}
```

### `--output-format stream-json` (TS extension)

NDJSON `success` event with the same full payload as `--output-format json`.

## Notes

- The `--output` flag has **no effect** on this command — `--output` values (`pretty|json|yaml|toml|env`) do not change text-mode rendering. Only the TS-extension `--output-format json|stream-json` produces a structured payload.
- UUID validation runs **after** project-ref resolution but **before** the API call. Error messages: `invalid snippet ID: invalid UUID length: N` for malformed lengths, `invalid snippet ID: invalid UUID format` for length-36 inputs with wrong dash positions or hex chars.
- The linked-project cache fires after project-ref resolves; the telemetry state always flushes. Both run on success and on every error path — including invalid-UUID early-exit — via the two `Effect.ensuring` blocks in the handler.
- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase snippets download` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that exactly matches a branch of the linked project, is
  within a small edit distance of one, or can't be checked because the branch listing failed stops
  the run before any other work with an error that offers both readings: `--remote=<word>` for the
  branch, `<word> --remote` for the operand. Any other word runs as the operand.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
