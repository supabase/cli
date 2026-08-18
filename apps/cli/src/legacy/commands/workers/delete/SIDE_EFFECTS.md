# `supabase workers delete <name>`

> **No live test yet.** `workers` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Workers routes are available on that stack.

## Files Read

| Path                                     | Format     | When                                                                                                        |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`         | TOML       | always, to report the source directory it kept                                                              |
| `<SUPABASE_HOME or ~/.supabase>/profile` | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`        |
| `<SUPABASE_PROFILE>` (YAML)              | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command |

## Files Written

| Path                                            | Format | When                                                            |
| ----------------------------------------------- | ------ | --------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                      |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after the project ref resolves, when the cache does not hold it |

The worker's directory and its `[workers.<name>]` entry are deliberately left
on disk; only the remote worker is deleted.

## Confirmation

Interactively, the worker's name has to be typed back before anything is
deleted. `--yes` (the root persistent flag) or `SUPABASE_YES` skips that. With
neither — and no interactive terminal to prompt on, which includes a redirected
stdout and any `--output-format json`/`stream-json` run — the command refuses
rather than deleting unasked.

## API Routes

| Method   | Path                                | Auth         | Request body | Response (used fields)                  |
| -------- | ----------------------------------- | ------------ | ------------ | --------------------------------------- |
| `GET`    | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | `spec.instances` (for the confirmation) |
| `DELETE` | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | status only                             |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success (a `404` on DELETE counts — it is already gone)                   |
| `1`  | invalid worker name                                                       |
| `1`  | nothing deployed under that name                                          |
| `1`  | the typed confirmation did not match the worker's name                    |
| `1`  | confirmation needed but no interactive terminal to ask on, and no `--yes` |
| `1`  | API error, or project not enrolled in the alpha                           |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)  |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                   | no (falls back to `~/.supabase`)                        |
| `SUPABASE_YES`          | auto-confirms the deletion, as `--yes` does          | no (defaults to prompting)                              |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.
