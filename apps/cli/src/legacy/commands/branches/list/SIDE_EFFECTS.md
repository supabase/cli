# `supabase branches list`

## Files Read

| Path                              | Format                    | When                                                       |
| --------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/.supabase/config.json` | JSON                      | always, to resolve linked project ref                      |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                          | Auth         | Request body | Response (used fields)                                                                                     |
| ------ | ----------------------------- | ------------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/branches` | Bearer token | none         | `[{id, name, is_default, git_branch, with_data, status, created_at, updated_at, project_ref, persistent}]` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — branches printed to stdout                            |
| `1`  | authentication error — no valid token found                     |
| `1`  | API error — non-2xx response from `/v1/projects/{ref}/branches` |
| `1`  | network / connection failure                                    |
| `1`  | unsupported output format (e.g. `--output env`)                 |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table to stdout. Columns: `ID`, `NAME`, `DEFAULT`, `GIT BRANCH`, `WITH DATA`, `STATUS`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`.

```
 ID                  | NAME    | DEFAULT | GIT BRANCH | WITH DATA | STATUS           | CREATED AT (UTC)    | UPDATED AT (UTC)
 --------------------|---------|---------|------------|-----------|------------------|---------------------|--------------------
 staging-project-ref | Staging | false   | develop    | true      | CREATING_PROJECT | 2026-01-02 03:04:05 | 2026-01-03 03:04:05
```

### `--output-format json`

Single JSON array emitted to stdout on success. Each element is the full branch object as returned by the Management API.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":[{...}]}
```

## Notes

- Requires a linked project (reads `--project-ref` or `.supabase/config.json`).
- The Go CLI also supports `--output toml` via its own flag. The TypeScript port uses the global `--output-format` flag instead.
