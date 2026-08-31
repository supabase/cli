# `supabase workers logs <name>`

> **No live test yet.** The other `workers` commands skip live coverage because they
> run against the v2 Management API, which the supabase/cli-e2e-ci supabox stack is
> not expected to serve. This one reads the v1 analytics endpoint, which that stack
> may well serve — but a meaningful assertion needs a deployed worker that has
> actually emitted log lines, which the stack cannot provide. Revisit alongside the
> rest of the family.

## Files Read

| Path                                          | Format     | When                                                                                                        |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential                                   |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--project-ref` nor `SUPABASE_PROJECT_ID` is set — names the linked project                    |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`        |
| `<SUPABASE_PROFILE>` (YAML)                   | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command |

The project config is **not** read. Unlike `status` and `delete`, nothing in this
command's output depends on local state — there is no source path to report — so
`config.toml` is never opened and an unparseable one cannot block a log read.

## Files Written

| Path                                            | Format | When                                                            |
| ----------------------------------------------- | ------ | --------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                      |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after the project ref resolves, when the cache does not hold it |

## API Routes

| Method | Path                                          | Auth         | Request                                                                                               | Response (used fields) |
| ------ | --------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `GET`  | `/v1/projects/{ref}/analytics/endpoints/logs` | Bearer token | `sql`, `iso_timestamp_start`, `iso_timestamp_end` as query parameters                                 | `result[]`, `error`    |
| `GET`  | `/v2/projects/{ref}/workers/{name}`           | Bearer token | none — **only when the log query returned no rows**, to tell "not deployed" from "deployed and quiet" | presence only          |
| `GET`  | `/v1/projects`                                | Bearer token | none — only when no ref resolved and the session is interactive                                       | project picker         |

Requires the `analytics_logs_read` permission, and the project must be on the
Workers private-alpha allow-list — an unenrolled project answers 404.

### The query

SQL in **ClickHouse dialect** against the project's unified `logs` table, filtered
on `log_attributes['worker']` and `log_attributes['source']`. It does **not** filter
the top-level `source` column: worker rows carry an empty string there, because the
Workers Logflare source is not enrolled as a category in the generic logs path.

### The window

Both `iso_timestamp_start` and `iso_timestamp_end` are always sent, spanning just
under 24 hours. This is not optional:

- one bound alone yields a **one-minute** window, server-side and silently;
- neither bound is an outright error;
- a span over 24 hours is **silently clamped** to `start + 24h`, which returns an
  older slice than the one requested rather than a truncated one.

### Rate limits

The v1 analytics endpoints allow **10 requests per 60 seconds**, and the server
applies a 30-second query timeout. One invocation spends one request, or two when
the result is empty.

## Exit Codes

| Code | Condition                                                    |
| ---- | ------------------------------------------------------------ |
| `0`  | success, including "no logs in the last 24 hours"            |
| `1`  | invalid worker name                                          |
| `1`  | nothing deployed under that name                             |
| `1`  | the log query failed (rejected, or the server's 30s timeout) |
| `1`  | log usage exceeded (402), or rate limited (429)              |
| `1`  | API error, or project not enrolled in the alpha              |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                        |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)          |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)           |
| `SUPABASE_PROJECT_ID`   | project ref, consulted after `--project-ref`         | no (falls back to `supabase/.temp/project-ref`, then the picker) |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)           |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                   | no (falls back to `~/.supabase`)                                 |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

`--source` is a choice flag, so its value is logged verbatim (a closed enum carries
no user data). `--project-ref` is not on this command's safe list, so its value is
redacted. No custom events.

## Output Formats

| Mode                          | stdout                                                                                              | stderr                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| text (default)                | one line per entry, oldest first, per-stream layout; `HH:MM:SS` local time; severity as colour      | the spinner, and the `status` hint when there are no logs |
| `--output-format json`        | one structured result carrying every entry                                                          | as above                                                  |
| `--output-format stream-json` | the same result as a single terminal event                                                          | as above                                                  |
| `-o json` / `yaml` / `toml`   | the same payload in that encoding, and nothing else                                                 | as above                                                  |
| `-o pretty` / `table` / `csv` | the text rendering — these fall through rather than encoding                                        | as above                                                  |
| `-o env`                      | refused before any request; the payload nests a `logs` array a flat `KEY=value` list cannot express | the error                                                 |

Text output prints the time in the reader's own timezone, matching the `--debug`
HTTP logger. Machine payloads carry the unambiguous forms instead — each entry's
`id`, both `timestamp` (ISO-8601 UTC) and `timestamp_ms` (raw epoch), `stream`,
`message`, the derived `level` when one exists, and the raw `attributes` map — whose values are all strings, since the column is a
`Map(String, String)`.

A `worker_guest_logs` message is bytes the tenant's own code printed. Control and
escape sequences are stripped before it reaches a terminal, so a worker cannot
reposition the cursor or forge CLI output; interior newlines and indentation are
preserved so a stack trace survives intact.
