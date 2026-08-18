# `supabase workers delete <name>`

> **TS-only command.** `supabase workers` has no Go counterpart — there is no
> `apps/cli-go/internal/workers` to match, and nothing is proxied. See
> `docs/go-cli-divergences.md`.

## Files Read

| Path                             | Format | When                                           |
| -------------------------------- | ------ | ---------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to report the source directory it kept |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

The worker's directory and its `[workers.<name>]` entry are deliberately left
on disk; only the remote worker is deleted.

## API Routes

| Method   | Path                                | Auth         | Request body | Response (used fields)                  |
| -------- | ----------------------------------- | ------------ | ------------ | --------------------------------------- |
| `GET`    | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | `spec.instances` (for the confirmation) |
| `DELETE` | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | status only                             |

## Exit Codes

| Code | Condition                                               |
| ---- | ------------------------------------------------------- |
| `0`  | success (a `404` on DELETE counts — it is already gone) |
| `1`  | invalid worker name                                     |
| `1`  | nothing deployed under that name                        |
| `1`  | the typed confirmation did not match the worker's name  |
| `1`  | API error, or project not enrolled in the alpha         |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)  |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events. `workers` has no Go counterpart, so there is no
`phtelemetry.*` call to reproduce.
