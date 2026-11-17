# `supabase warehouse connection`

Target: hosted, no consent, see [Command target](../../../../../docs/command-target.md)

## Feature gate

Registered only when `experimental.warehouse` is enabled: set `[experimental] warehouse = true` or
`SUPABASE_EXPERIMENTAL_WAREHOUSE=1`. `--experimental` alone does not expose it. When disabled the
`warehouse` group is absent from help and completion and from the generated command documentation.
The command is generated from the Management API contract (`generated.ts`).

## Files Read

| Path                                          | Format     | When                                                                               |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`              | JSON       | when present, to resolve `experimental.warehouse` before the command tree is built |
| `<workdir>/supabase/config.toml`              | TOML       | when no `config.json` exists, for the same setting                                 |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential          |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--project-ref`/`--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set     |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set                             |

## Files Written

| Path                                            | Format | When                                                                                |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always, flushed on success and on failure                                           |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once the project ref resolved, only when no such file exists for that ref |

## API Routes

| Method | Path                                      | Auth         | Request body | Response (used fields)                                          |
| ------ | ----------------------------------------- | ------------ | ------------ | --------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/warehouse/connection` | Bearer token | none         | passed through unchanged                                        |
| `GET`  | `/v1/projects`                            | Bearer token | none         | only when no ref resolved and the session is interactive        |
| `GET`  | `/v1/projects/{ref}`                      | Bearer token | none         | linked-project cache miss only (best-effort, after the command) |

No operation-specific query parameters. The command never requests or prints a password, token or
catalog credential, and does not run a Flight SQL query: `query_connectivity` stays `not_checked`.
`--dry-run` prints `{method, path, query, headers, body}` and sends no command request (the linked-project cache read in the table above can still run).

The response describes Arrow Flight SQL access only; DuckLake catalog access is a separate contract.
`endpoint`, `host` and `port` are present only while `status` is `available` or `pending`; a
disabled, unconfigured or unavailable Warehouse prints `-` for them instead of a connection string.

## Connecting

Log in as a role in the source Supabase database with that role's existing password; `postgres`
uses the project's database password. The role needs `supabase_warehouse_reader` membership in the
source database, which Management API access does not grant. With
[usql](https://github.com/xo/usql), using the `host` from the output:

```sh
usql -W 'flightsql://postgres@<host>:443?tls=enabled'
```

## Exit Codes

| Code | Condition                                                                     |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | successful read (including not configured, disabled or unavailable Warehouse) |
| `2`  | `usage_error`: invalid flags                                                  |
| `1`  | API error (non-2xx)                                                           |

## Environment Variables

| Variable                          | Purpose                                                                                                            | Required?                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `SUPABASE_EXPERIMENTAL_WAREHOUSE` | command registration (boolean `1`/`true` enables, `0`/`false` disables; unset/empty uses `experimental.warehouse`) | no                                              |
| `SUPABASE_ACCESS_TOKEN`           | auth token (bypasses credential file/keyring lookup)                                                               | no (falls back to keyring, then `access-token`) |
| `SUPABASE_PROFILE`                | built-in profile name or YAML file path                                                                            | no (falls back to `~/.supabase/profile`)        |
| `SUPABASE_PROJECT_ID`             | project ref, consulted after `--project-ref`                                                                       | no (falls back to `supabase/.temp/project-ref`) |
| `SUPABASE_WORKDIR`                | project directory the command acts on                                                                              | no (falls back to `--workdir`, then the cwd)    |
| `SUPABASE_HOME`                   | directory holding `telemetry.json`                                                                                 | no (falls back to `~/.supabase`)                |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

Only the names of flags passed appear in `flags`. Target flags record their values, and `--dry-run`
records `true`.

## Output

Text rendering applies on a terminal by default, with `--output-format text` (also when piped), and
with `-o pretty`. Piped runs, agent runs, `--output-format json|stream-json` and `-o json` keep the
API's JSON bytes. `-o` takes precedence over `--output-format`.

| Mode                           | stdout                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| text presentation              | the response as labelled fields, with authentication guidance as a nested block     |
| JSON presentation              | the API's JSON response bytes, unchanged                                            |
| `-o json`                      | the same bytes; no `target` key is added                                            |
| `-o yaml`                      | the same document as YAML                                                           |
| `--dry-run`, text presentation | `Dry run: <METHOD> <path>`, then `Query`, `Headers` and indented JSON `Body` blocks |
| `--dry-run` otherwise          | the request preview as JSON                                                         |

When the presentation is text and `--output-format` is `text`, the request runs under a task. On a terminal it
is a spinner; when stdout is not a terminal (for example `--output-format text` piped) the task
message prints as a step line on stdout before the response. JSON and YAML output show no progress.
