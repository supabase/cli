# `supabase encryption [get-root-key|update-root-key]`

Manage a project's pgsodium root encryption key. Each subcommand resolves a
project ref and calls one Management API endpoint. `update-root-key`
additionally reads the new key from stdin.

## Files Read

| Path                                             | Format                    | When                                                               |
| ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| `~/.supabase/access-token`                       | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable         |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON                      | when `--project-ref` / `PROJECT_ID` unset, to resolve linked ref   |
| stdin                                            | raw bytes / masked TTY    | `update-root-key` only — masked TTY input or piped bytes (the key) |

## Files Written

| Path                                             | Format | When                                              |
| ------------------------------------------------ | ------ | ------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | PersistentPostRun, after the project ref resolves |
| `~/.supabase/telemetry.json`                     | JSON   | PersistentPostRun, on success or failure          |

## API Routes

| Method | Path                          | Auth         | Request body | Response (used fields) |
| ------ | ----------------------------- | ------------ | ------------ | ---------------------- |
| `GET`  | `/v1/projects/{ref}/pgsodium` | Bearer token | none         | `{root_key}`           |
| `PUT`  | `/v1/projects/{ref}/pgsodium` | Bearer token | `{root_key}` | `{root_key}`           |

`get-root-key` calls `GET`; `update-root-key` calls `PUT`.

## Environment Variables

| Variable                             | Purpose                                              | Required?                                               |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`              | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID` / `PROJECT_ID` | project ref (fallback when `--project-ref` unset)    | no (falls back to linked-project file → prompt)         |
| `SUPABASE_API_URL`                   | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |
| `SUPABASE_PROFILE`                   | built-in profile name or YAML file path              | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                 |
| ---- | ----------------------------------------- |
| `0`  | success                                   |
| `1`  | project ref unresolved / malformed        |
| `1`  | network / connection failure              |
| `1`  | non-200 status from the pgsodium endpoint |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                         |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` redacted — not telemetry-safe) |

No custom `phtelemetry.*` events in `internal/encryption/`.

## Output

### `--output-format text` (Go CLI compatible)

- `get-root-key`: the bare root key followed by a newline, to **stdout** (Go `fmt.Println`).
- `update-root-key`: `Finished supabase root-key update.` followed by a newline, to **stderr**
  (Go's `utils.Aqua` color rendered as plain text per the legacy-port convention).

### `--output-format json`

A single JSON object emitted to stdout: `{"root_key":"…"}` (both subcommands).

### `--output-format stream-json`

One `result` event carrying `{root_key}` (both subcommands).

```ndjson
{"type":"result","data":{"root_key":"…"}}
```

## Notes

- Requires `--project-ref`, `SUPABASE_PROJECT_ID`/`PROJECT_ID`, or a linked project.
- `update-root-key` reads the key from stdin: a real TTY is read with a masked
  prompt; piped stdin is decoded as UTF-8 and whitespace-trimmed. An empty or
  whitespace-only key sends an empty `root_key`, matching Go's `io.Copy` +
  `strings.TrimSpace` behavior. (The TTY masked prompt also trims, matching Go.)
- **Known divergence:** Go writes the bare prompt `Enter a new root key: ` to
  stderr and reads via `term.ReadPassword`. The port uses a clack masked prompt
  with the same label text, so the rendered TTY prompt is not byte-identical to
  Go (clack adds its own framing). Piped (non-TTY) mode does not print the prompt
  at all — it reads stdin directly, as Go's `io.Copy` branch does.
