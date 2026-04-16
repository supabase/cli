# `supabase branches get`

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

| Method | Path                       | Auth         | Request body | Response (used fields)                                                                 |
| ------ | -------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------- |
| `GET`  | `/v1/branches/{branch_id}` | Bearer token | none         | `{db_host, db_port, db_user, db_pass, jwt_secret, ref, postgres_version, status, ...}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                    |
| ---- | ------------------------------------------------------------ |
| `0`  | success — branch details printed to stdout                   |
| `1`  | authentication error — no valid token found                  |
| `1`  | API error — non-2xx response from `/v1/branches/{branch_id}` |
| `1`  | network / connection failure                                 |
| `1`  | branch not found (404)                                       |

## Output

### `--output-format text` (Go CLI compatible)

Prints a table with columns: `HOST`, `PORT`, `USER`, `PASSWORD`, `JWT SECRET`, `POSTGRES VERSION`, `STATUS`.

### `--output-format json`

Single JSON object emitted to stdout on success.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Accepts optional positional `[name]` argument (branch name or ID). If omitted in interactive mode, prompts the user to select from a list of branches.
- When `--output toml` is used in Go CLI, it emits connection strings as `.env`-style TOML; this format is not reproduced in the TS port.
