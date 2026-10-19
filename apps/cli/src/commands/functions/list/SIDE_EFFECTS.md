# `supabase functions list`

## Files Read

| Path                                            | Format     | When                                                           |
| ----------------------------------------------- | ---------- | -------------------------------------------------------------- |
| `~/.supabase/access-token`                      | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable     |
| `~/.supabase/profile`                           | plain text | when `--profile` and `SUPABASE_PROFILE` are both unset         |
| `<profile>.yaml`                                | YAML       | when `SUPABASE_PROFILE` or `--profile` points to a file        |
| `<workdir>/supabase/.temp/project-ref`          | plain text | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON       | when present, before post-run telemetry state is refreshed     |

## Files Written

| Path                                            | Format | When                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once a project ref has resolved (success or failure), only when no such file exists, `<workdir>/supabase/.temp/project-ref` doesn't name another ref, an access token exists and `GET /v1/projects/{ref}` returns 200 |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | after command completion, flushed on both success and failure paths                                                                                                                                                             |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/functions`   | Bearer token | none         | `[{id, name, slug, status, version, updated_at, ...}]`                                                                                                                                                                                                   |
| `GET`  | `/v1/projects`                   | Bearer token | none         | project picker options when no ref is supplied in TTY                                                                                                                                                                                                    |
| `GET`  | `/v1/projects/{ref}`             | Bearer token | none         | linked project metadata used by the post-run cache                                                                                                                                                                                                       |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |

## Environment Variables

| Variable                | Purpose                                                        | Required?                                                 |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)           | no (falls back to keyring -> `~/.supabase/access-token`)  |
| `SUPABASE_HOME`         | overrides where `telemetry.json` is read and written           | no (defaults to `~/.supabase`)                            |
| `SUPABASE_PROFILE`      | select a built-in profile or YAML profile file with `api_url:` | no (falls back to `~/.supabase/profile` -> `supabase`)    |
| `SUPABASE_PROJECT_ID`   | provides the project ref when `--remote=<ref>` is not given    | no (falls back to `<workdir>/supabase/.temp/project-ref`) |
| `SUPABASE_WORKDIR`      | sets `<workdir>` for local Supabase temp files                 | no (falls back to `--workdir` -> current working dir)     |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | network / connection failure          |
| `1`  | unsupported `--output` mode (`env`)   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

Prints a styled ASCII table with columns `ID`, `NAME`, `SLUG`, `STATUS`, `VERSION`, and `UPDATED_AT (UTC)`.

### `--output-format json`

Prints a structured success result shaped as `{ "functions": [...], "target": {...} }`, where `target` is `kind: "linked"` with `project_ref` and, when known, `project_name`, `environment` and `parent_project_ref`.

### `--output-format stream-json`

Prints the same structured success result, including `target`.

## Notes

- Targets the linked project unless `--remote=<ref>` is given; a bare `--remote` also targets the linked project. `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked project (by name or UUID, resolved through `GET /v1/projects/{parent}/branches`, or `GET /v1/branches/{id}` for a UUID when no project is linked), or `true|yes|on|1` for the linked project. A database URL is rejected (`supabase functions list` takes a project, not a database); `false|no|off|0` and `--no-remote` fail with `--remote doesn't take false. Leave it out to use the linked project.`, and an empty value with `--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` and prints a deprecation warning on stderr that names the replacement; it cannot be combined with `--remote=<value>`. An empty `--project-ref` is rejected.
- Requires a linked project (`--remote=<ref>`, `SUPABASE_PROJECT_ID`, or `<workdir>/supabase/.temp/project-ref`).
- Uses the Management API.
- Prints the `Target:` banner (project name, ref and, for a branch, the parent project) to stderr before the request. It never asks for confirmation, so `--yes` and `SUPABASE_YES` have no effect.
- `--output` behavior:
  - `json` emits the raw array, without `target`.
  - `yaml` emits the raw array, without `target`.
  - `toml` emits `{ functions = [...] }`.
  - `env` fails with `--output env flag is not supported`.
