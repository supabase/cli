# `supabase warehouse enable`

Target: hosted, consent default No (confirm unless `--yes`; a run that cannot prompt and has no `--yes` is a usage error), see [Command target](../../../../../docs/command-target.md)

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
| `<file>`                                      | JSON       | only with `--file <path>`: the whole request body (`--file -` reads stdin)         |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential          |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--project-ref`/`--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set     |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set                             |

## Files Written

| Path                                            | Format | When                                                                                |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always, flushed on success and on failure                                           |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once the project ref resolved, only when no such file exists for that ref |

## API Routes

| Method | Path                                          | Auth         | Request body                                                                                       | Response (used fields)                                                                                                                        |
| ------ | --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v2/projects/{ref}/warehouse/enable`         | Bearer token | `{"data":{"type":"warehouse_setup","attributes":{…}}}`; only the flags that were given are present | passed through unchanged; `data.attributes.selection_id` feeds `--wait`                                                                       |
| `GET`  | `/v2/projects/{ref}/warehouse/setups/current` | Bearer token | none                                                                                               | `data.attributes.status`, `status_error`; polled with backoff from 1s doubling to a 10s cap (a longer `Retry-After` wins), only with `--wait` |
| `GET`  | `/v1/projects`                                | Bearer token | none                                                                                               | only when no ref resolved and the session is interactive (project picker)                                                                     |
| `GET`  | `/v1/projects/{ref}`                          | Bearer token | none                                                                                               | `{ref, name, organization_id, organization_slug}`; linked-project cache miss only (best-effort, after the command)                            |

`--body` or `--file` supply the whole body; a flag replaces its own field and nothing else. The
input is validated before consent and before any request, so a top-level body key outside the
declared request-body fields, an unknown nested field or a missing `--schema` fails with nothing sent. `--dry-run` prints `{method, path, query, headers, body}` and sends no command request (the linked-project cache read in the table above can still run),
before consent.

## Exit Codes

| Code  | Condition                                                                |
| ----- | ------------------------------------------------------------------------ |
| `0`   | success (the request was accepted, or with `--wait` the setup succeeded) |
| `2`   | `usage_error`: invalid flags or body, or consent needed without `--yes`  |
| `130` | consent declined at the prompt (`cancelled`)                             |
| `1`   | API error (non-2xx)                                                      |
| `1`   | with `--wait`: `operation_failed` (a failed status) or `wait_timeout`    |

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
and `--wait` record `true`. Generated field flags, `--body`, `--file` and `--timeout` are recorded as
`<redacted>`.

## Output

| Mode           | stdout                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| text (default) | the API's JSON response bytes, unchanged; with `--wait` the final status response |
| `-o json`      | the same bytes; no `target` key is added                                          |
| `-o yaml`      | the same document as YAML; other `-o` values are a usage error                    |
| `--dry-run`    | the request preview as JSON                                                       |

## Notes

- Repeating the same selection is safe; the API rejects a different existing selection.
- `--wait` fails only on a status in the failed set; `status_error` supplies the failure message and does not end the wait by itself.
- `data.attributes.selection_id` is required in the accepted response; a response without it is a defect and ends `--wait` with an internal error, never a silent success.
- `--wait` never resumes after a 409; any non-2xx while polling ends the command with the API error.
