# `supabase snippets download`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` flag and `PROJECT_ID` env are unset                                      |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |

## Files Written

| Path                                           | Format | When                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves (Go `PersistentPostRun`) |

## API Routes

| Method | Path                | Auth         | Request body | Response (used fields)                                                                                       |
| ------ | ------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/snippets/{id}` | Bearer token | none         | `{content: {sql, schema_version, favorite?}, id, name, visibility, owner, project, inserted_at, updated_at}` |

Only `content.sql` is rendered in text mode. The full payload is exposed via `--output-format json`.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref`)         |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                           |
| ---- | ------------------------------------------------------------------- |
| `0`  | success — SQL written to stdout                                     |
| `1`  | `LegacySnippetsInvalidIdError` — `<snippet-id>` is not a valid UUID |
| `1`  | `LegacyInvalidProjectRefError` / `LegacyProjectNotLinkedError`      |
| `1`  | `LegacySnippetsDownloadUnexpectedStatusError` — non-2xx response    |
| `1`  | `LegacySnippetsDownloadNetworkError` — transport-level failure      |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |

## Output

### `--output-format text` (Go CLI compatible)

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

- Go's `--output` flag is **ignored** by `download.Run` — `fmt.Println(resp.JSON200.Content.Sql)` runs regardless of `pretty|json|yaml|toml|env`. The TS port mirrors this exactly: Go-style `--output` values do not change text-mode rendering. Only the TS-extension `--output-format json|stream-json` produces a structured payload.
- UUID validation runs **after** project-ref resolution but **before** the API call, matching Go's lifecycle: `PersistentPreRunE` resolves the ref first, then `download.Run` validates via `uuid.Parse`. Error messages mirror google/uuid v1.6.0: `invalid snippet ID: invalid UUID length: N` for malformed lengths, `invalid snippet ID: invalid UUID format` for length-36 inputs with wrong dash positions or hex chars.
- The linked-project cache fires after project-ref resolves (Go `PersistentPostRun`); the telemetry state always flushes (Go `Execute`). Both run on success and on every error path — including invalid-UUID early-exit — via the two `Effect.ensuring` blocks in the handler.
