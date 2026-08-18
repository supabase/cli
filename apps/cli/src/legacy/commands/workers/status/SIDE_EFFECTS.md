# `supabase workers status <name>`

> **TS-only command.** `supabase workers` has no Go counterpart — there is no
> `apps/cli-go/internal/workers` to match, and nothing is proxied. See
> `docs/go-cli-divergences.md`.

## Files Read

| Path                             | Format | When                                            |
| -------------------------------- | ------ | ----------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to report the worker's source directory |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                | Auth         | Request body | Response (used fields)                                                                             |
| ------ | ----------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | `spec`, `build_state`, `state_reason`, `image_version`, `instances`, `instances_error`, `deleting` |

## Exit Codes

| Code | Condition                                       |
| ---- | ----------------------------------------------- |
| `0`  | success                                         |
| `1`  | invalid worker name                             |
| `1`  | nothing deployed under that name                |
| `1`  | API error, or project not enrolled in the alpha |

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
