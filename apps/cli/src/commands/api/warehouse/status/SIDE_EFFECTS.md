# `supabase warehouse status`

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

| Method | Path                                          | Auth         | Request body | Response (used fields)                                          |
| ------ | --------------------------------------------- | ------------ | ------------ | --------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/warehouse/setups/current` | Bearer token | none         | passed through unchanged                                        |
| `GET`  | `/v1/projects`                                | Bearer token | none         | only when no ref resolved and the session is interactive        |
| `GET`  | `/v1/projects/{ref}`                          | Bearer token | none         | linked-project cache miss only (best-effort, after the command) |

Query: `inspect_fdw=true|false` and `selection_id=<id>`, each only when its flag was given.
`--dry-run` prints `{method, path, query, headers, body}` and sends no command request (the linked-project cache read in the table above can still run).

With `--wait` the command sends no change request: the first send is the first poll, and it polls
its own route with its own flags. Polling backs off from 1s, doubling to a 10s cap (a longer
`Retry-After` wins), until `data.attributes.status` is `succeeded` or `failed` or `--timeout`
(default `10m`) elapses. The output is the last read. Any non-2xx while polling ends the command
with the API error.

## Exit Codes

| Code | Condition                                                                                  |
| ---- | ------------------------------------------------------------------------------------------ |
| `0`  | success (with `--wait`, the setup succeeded)                                               |
| `2`  | `usage_error`: invalid flags                                                               |
| `1`  | API error (non-2xx, including 409)                                                         |
| `1`  | with `--wait`: `operation_failed` (a failed status, with `status_error`) or `wait_timeout` |

A 4xx `entitlement_required` body (`{"error":{"code":"entitlement_required","feature","upgrade_url"}}`) adds `entitlement: {feature, upgrade_url}` to the stderr error document in place of the token-permission hint; a terminal run prints the upgrade hint, and `cli_upgrade_suggested` fires. Other statuses and bodies carry no `entitlement` key.

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
and `--wait` record `true`. Generated field flags (`--inspect-fdw`, `--selection-id`) and `--timeout`
are recorded as `<redacted>`.

## Output

Text rendering applies on a terminal by default, with `--output-format text` (also when piped), and
with `-o pretty`. Piped runs, agent runs, `--output-format json|stream-json` and `-o json` keep the
API's JSON bytes. `-o` takes precedence over `--output-format`.

| Mode                           | stdout                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| text presentation              | the response as labelled fields and tables; with `--wait` the last read; an empty response prints `Done.` |
| JSON presentation              | the API's JSON response bytes, unchanged; with `--wait` the last read                                     |
| `-o json`                      | the same bytes; no `target` key is added                                                                  |
| `-o yaml`                      | the same document as YAML                                                                                 |
| `--dry-run`, text presentation | `Dry run: <METHOD> <path>`, then `Query`, `Headers` and indented JSON `Body` blocks                       |
| `--dry-run` otherwise          | the request preview as JSON                                                                               |

When the presentation is text and `--output-format` is `text`, each request, and with `--wait` the
whole polling phase, runs under a task that shows the polled status after 200 ms. On a terminal it
is a spinner; when stdout is not a terminal (for example `--output-format text` piped) the task
message prints as a step line on stdout before the response. JSON and YAML output show no progress.
