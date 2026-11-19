# Generated API commands

Target: hosted, see [Command target](../../../docs/command-target.md). Read-only commands ask for no
consent; mutations default to No (confirm unless `--yes`; a run that cannot prompt and has no `--yes`
is a usage error).

Every command generated from the Management API contract shares this contract: one central policy
(`api-command-policy.ts`) selects the operations, `generated.ts` holds the derived command data, and
one runtime executes it. Hand-written commands keep their own `SIDE_EFFECTS.md`. The per-command
details (request route, request body, flags and where each binds, the `--wait` read) are in the
generated [per-command reference](./generated.md); that file is the source for routes, flag
bindings and wait settings, and the sections below do not repeat them.

## Feature gate

Each noun belongs to one feature. Its commands are registered only when `experimental.<feature>` is
enabled: set `[experimental] <feature> = true` or `SUPABASE_EXPERIMENTAL_<FEATURE>=1`. The setting
is resolved before the command tree is built, so `--experimental` alone does not expose the
commands. When the feature is disabled the noun is absent from help, completion and the generated
command documentation.

## Joining hand-written groups

A generated command joins the hand-written group of the same name, at any depth, so a noun such as
`warehouse` can sit beside hand-written `warehouse` commands. The generator fails only when a
generated command path equals a hand-written command or group, or when a group on its path is a
hand-written command. A hand-written group is described by its own code, so the nouns table gives a
description only to groups the generator creates. Joining rebuilds the group, so a hand-written
group carries only metadata (descriptions, flags, subcommands) and provides layers on each
subcommand: a `Command.provide` on the group itself would be bypassed for every subcommand.

## Files Read

| Path                                          | Format     | When                                                                               |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`              | JSON       | when present, to resolve `experimental.<feature>` before the command tree is built |
| `<workdir>/supabase/config.toml`              | TOML       | when no `config.json` exists, for the same setting                                 |
| `<file>`                                      | JSON       | only with `--file <path>`: the whole request body (`--file -` reads stdin)         |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential          |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--project-ref`/`--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set     |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set                             |

Commands never write project configuration, execute SQL locally or read stdin, except `--file -`.

## Files Written

| Path                                            | Format | When                                                                                |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always, flushed on success and on failure                                           |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once the project ref resolved, only when no such file exists for that ref |

## API Routes

Each command sends the one request described in the [per-command reference](./generated.md), with
Bearer token authentication, and passes the JSON response through unchanged. The calls every command
can add:

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                      |
| ------ | -------------------------------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                   | Bearer token | none         | only when no ref resolved and the session is interactive (project picker)                                                                                                                                   |
| `GET`  | `/v1/projects/{ref}`             | Bearer token | none         | `{ref, name, organization_id, organization_slug}`; linked-project cache miss only (best-effort, after the command)                                                                                          |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>`, and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                            |

With `--wait`, the command also polls the read operation named in its reference entry.

### Request input

- `--body` or `--file` supply the whole body; a flag replaces its own field and nothing else.
- A flag for a nested body field (an object, an array of objects or a union) takes a JSON value for
  that field, `null` included; text that is not JSON is a usage error naming the flag.
- The input is validated before consent and before the command request: a top-level body key
  outside the declared request-body fields, an unknown nested field or a missing required flag
  fails with no command request sent. `-o`/`--output` and an invalid `--timeout` fail first, before
  target resolution; for other input errors target resolution runs first, so the project picker and
  branch lookups in the table above can still run.
- A body whose fields form alternatives (the request needs one of several fields) reports a missing
  choice as `Pass at least one of --a, --b`.
- `--dry-run` prints `{method, path, query, headers, body}` and sends no command request, before
  consent. The linked-project cache read in the table above can still run. It shows the local
  request, not a server-resolved impact.
- Consent uses the command's summary as the action and lists what the validated request does: one
  `name: value` line per non-ref path parameter, query parameter and body field (for an envelope
  body, the fields under `data.attributes`). Scalars print as is; objects and arrays print as
  compact JSON.

## `--wait`

A command whose reference entry has a Wait section accepts `--wait` and `--timeout <duration>`
(a duration such as `90s` or `10m`; default `10m`; an invalid or non-positive value is a usage
error). `--timeout` is validated whenever it is passed, even without `--wait`, before consent and
before any command request.

- A mutation first sends its request, then reads the identity the wait needs from the response by
  the pointers in its reference entry. A missing value is a defect in the response and ends the wait
  with an internal error, never a silent success.
- A read that polls itself sends no separate change request: its own input is polled.
- Polling repeats the read with backoff from 1s doubling to a 10s cap; a longer `Retry-After` on the
  last response wins.
- The wait succeeds on a status in the succeeded set and fails (`operation_failed`) on a status in
  the failed set. The failure pointer only supplies the error message and never ends the wait by
  itself.
- Each poll read goes through the API client's own retries (429 and 5xx). Any non-2xx response left
  after them, a 409 included, ends the command with the API error; the wait never resumes.
- At the timeout the command fails with `wait_timeout`. Timeout and cancellation stop local polling
  only and do not change server state.
- The failure and timeout hint names the command that re-reads the state. When the polled read is a
  generated command, the hint names it with the identity the wait polled with, for example
  `supabase <noun> <read> --<identity-flag> <id> --remote=<ref>`. When the polled read is a hidden
  read, the hint names the command its `poll.inspect` operation generates, with only `--remote=<ref>`.
- With `--wait`, stdout carries the final read response instead of the change response.

## Exit Codes

| Code  | Condition                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------- |
| `0`   | success: the request was accepted, the dry run printed, or the wait ended on a succeeded status |
| `2`   | `usage_error`: invalid flags, body or timeout, or consent needed without `--yes`                |
| `130` | consent declined at the prompt (`cancelled`)                                                    |
| `1`   | API error (non-2xx)                                                                             |
| `1`   | with `--wait`: `operation_failed` (a failed status) or `wait_timeout`                           |

A 4xx `entitlement_required` body (`{"error":{"code":"entitlement_required","feature","upgrade_url"}}`)
adds `entitlement: {feature, upgrade_url}` to the stderr error document in place of the
token-permission hint; a terminal run prints the upgrade hint, and `cli_upgrade_suggested` fires.
Other statuses and bodies carry no `entitlement` key.

Errors use the standard stderr envelope. `wait_timeout` includes `timeout_ms`, a nullable
`last_status` and the hint command; terminal text includes the last status. `operation_failed`
includes the failed status and the reported failure message.

## Environment Variables

| Variable                          | Purpose                                                                                                            | Required?                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `SUPABASE_EXPERIMENTAL_<FEATURE>` | command registration (boolean `1`/`true` enables, `0`/`false` disables; unset/empty uses `experimental.<feature>`) | no                                              |
| `SUPABASE_ACCESS_TOKEN`           | auth token (bypasses credential file/keyring lookup)                                                               | no (falls back to keyring, then `access-token`) |
| `SUPABASE_PROFILE`                | built-in profile name or YAML file path                                                                            | no (falls back to `~/.supabase/profile`)        |
| `SUPABASE_PROJECT_ID`             | project ref, consulted after `--project-ref`                                                                       | no (falls back to `supabase/.temp/project-ref`) |
| `SUPABASE_WORKDIR`                | project directory the command acts on                                                                              | no (falls back to `--workdir`, then the cwd)    |
| `SUPABASE_HOME`                   | directory holding `telemetry.json`                                                                                 | no (falls back to `~/.supabase`)                |
| `SUPABASE_YES`                    | consent for mutations in a shell; `supabase/.env` and a cwd `.env*` file do not count                              | no (falls back to `--yes`)                      |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

Only the names of flags passed appear in `flags`. Target flags record their values, and `--dry-run`
and `--wait` record `true`. Generated field flags, `--body`, `--file` and `--timeout` are recorded as
`<redacted>`. Response and error contents never become telemetry properties.

## Output

The presentation is text only when `--output-format` is `text` and stdout is a terminal; successes
and failures follow the same rule. Piped runs (even with `--output-format text`), agent runs and
`--output-format json|stream-json` keep the API's JSON bytes. `-o`/`--output` is a usage error that
points to `--output-format`, raised before target resolution, consent or any request.

| Mode                           | stdout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| text presentation              | the response as labelled fields and tables, nested objects as indented blocks; a collection prints its scalar fields as a table, with each item's nested fields, null shown as `-`, in a block below it, and a `points` sample series shows its last 10 samples in response order with an omission notice (`--output-format json` shows all of them), `-` for null or empty values; with `--wait` the final read response; an empty response prints `Done.` and an empty collection `No results` |
| JSON presentation              | the API's JSON response bytes, unchanged, preserving unknown and null fields; with `--wait` the final read response                                                                                                                                                                                                                                                                                                                                                                              |
| `--dry-run`, text presentation | `Dry run: <METHOD> <path>`, then `Query`, `Headers` and indented JSON `Body` blocks                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--dry-run` otherwise          | the request preview in the selected JSON presentation                                                                                                                                                                                                                                                                                                                                                                                                                                            |

With the text presentation, each request, and with `--wait` the whole polling phase, runs under a
task that shows the polled status after 200 ms, as a spinner on the terminal. JSON output shows no
progress.
