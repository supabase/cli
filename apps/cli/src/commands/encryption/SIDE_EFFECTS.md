# `supabase encryption [get-root-key|update-root-key]`

Target: hosted, consent default No for `update-root-key`, no consent for `get-root-key` — see [Command target](../../../docs/command-target.md)

Manage a project's pgsodium root encryption key. Each subcommand resolves a
project ref and calls one Management API endpoint. `update-root-key`
additionally reads the new key from stdin.

## Files Read

| Path                                           | Format                    | When                                                                                                         |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                   |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write    |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set; also by `linkedProjectCache` on a cache miss |
| stdin                                          | raw bytes / masked TTY    | `update-root-key` only — masked TTY input or piped bytes (the key)                                           |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | in `Effect.ensuring` after the project ref resolves (and, for `update-root-key`, after the key is read), on success or failure of the API call — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | post-run, on success or failure                                                                                                                                                                                                                                                                    |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                   | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`  | `/v1/projects/{ref}/pgsodium`    | Bearer token | none         | `{root_key}`                                                                                                                                                                                                                                             |
| `PUT`  | `/v1/projects/{ref}/pgsodium`    | Bearer token | `{root_key}` | `{root_key}`                                                                                                                                                                                                                                             |
| `GET`  | `/v1/projects/{ref}`             | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |

`get-root-key` calls `GET`; `update-root-key` calls `PUT`.

## Environment Variables

| Variable                | Purpose                                                                                               | Required?                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                  | no (falls back to keyring → `~/.supabase/access-token`)                                       |
| `SUPABASE_PROJECT_ID`   | project ref (fallback when `--remote=<ref>` is not given)                                             | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                               | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_YES`          | confirms the hosted mutation without asking; only the shell environment counts, never `supabase/.env` | no (falls back to the interactive prompt)                                                     |

## Exit Codes

| Code | Condition                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                       |
| `1`  | project ref unresolved / malformed                                                                                                            |
| `1`  | network / connection failure                                                                                                                  |
| `1`  | non-200 status from the pgsodium endpoint                                                                                                     |
| `1`  | `update-root-key`: declined at the confirmation prompt (`HostedMutationDeclinedError`, `context canceled`) — nothing is changed               |
| `1`  | `update-root-key`: JSON, stream-json, `-o` or non-interactive run without `--yes` (`HostedMutationConsentRequiredError`) — nothing is changed |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                                           |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote=<ref>` → the ref, a bare `--remote` → `true`, any other `--remote` value → `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`) |

No custom `phtelemetry.*` events in `internal/encryption/`.

## Output

### `--output-format text`

- `get-root-key`: the bare root key followed by a newline, to **stdout**.
- `update-root-key`: `Finished supabase root-key update.` followed by a newline, to **stderr**
  (color rendered as plain text).

### `--output-format json`

A single JSON object emitted to stdout: `{"root_key":"…"}` (both subcommands).

### `--output-format stream-json`

One `result` event carrying `{root_key}` (both subcommands).

```ndjson
{"type":"result","data":{"root_key":"…"}}
```

## Notes

- `update-root-key` reads the key from stdin: a real TTY is read with a masked
  prompt; piped stdin is decoded as UTF-8 and whitespace-trimmed. An empty or
  whitespace-only key sends an empty `root_key` (the TTY masked prompt also trims).
- The TTY prompt is a clack masked prompt labelled `Enter a new root key: `
  (clack adds its own framing). Piped (non-TTY) mode does not print the
  prompt at all — it reads stdin directly.
- `update-root-key` asks `Replace the project's root encryption key on <target>?` (default No) before the first write.
- The new key is read (masked TTY prompt or piped stdin) before the confirmation, which never reads stdin.
