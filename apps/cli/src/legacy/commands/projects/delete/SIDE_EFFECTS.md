# `supabase projects delete`

## Files Read

| Path                                   | Format                    | When                                                       |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/supabase/.temp/project-ref` | plain text (ref string)   | after a successful delete, to decide whether to unlink     |

## Files Written / Removed

| Path                        | Action  | When                                                           |
| --------------------------- | ------- | -------------------------------------------------------------- |
| `<workdir>/supabase/.temp/` | removed | when the deleted ref matches the linked ref file (best-effort) |

> Also runs Go's best-effort per-ref keyring delete: a missing entry is swallowed;
> an unsupported keyring prints `Keyring is not supported on WSL` to stderr (Go parity).

## API Routes

| Method   | Path                 | Auth         | Request body | Response (used fields)        |
| -------- | -------------------- | ------------ | ------------ | ----------------------------- |
| `DELETE` | `/v1/projects/{ref}` | Bearer token | none         | `{ref: string, name: string}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                  |
| ---- | ---------------------------------------------------------- |
| `0`  | success — project deleted                                  |
| `1`  | authentication error — no valid token found                |
| `1`  | project not found — 404 response from `/v1/projects/{ref}` |
| `1`  | API error — non-2xx/404 response from `/v1/projects/{ref}` |
| `1`  | network / connection failure                               |
| `1`  | declined confirmation (cancellation) / no ref on a non-TTY |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Flags

| Flag    | Type | Required (non-interactive) | Description                        |
| ------- | ---- | -------------------------- | ---------------------------------- |
| `[ref]` | arg  | yes (non-interactive)      | Project ref to delete (positional) |

## Output

### `--output-format text` (Go CLI compatible)

Prompts `Do you want to delete project <ref>? This action is irreversible.` (default
**No**, honours the global `--yes`), then on success prints `Deleted project: <name>`
to stdout.

### `--output-format json`

`success("Deleted project", { name })`.

```json
{ "name": "my-project" }
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{"name":"my-project"}}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- In interactive mode (when stdin is a TTY and no ref is provided), the CLI prompts the
  user to select a project to delete.
- In non-interactive mode (when stdin is not a TTY), the project ref positional argument
  is required.
- A `PreRun` check is performed before the DELETE call to validate the project ref and
  display a confirmation prompt in interactive mode.
