# `supabase traces`

Target: hosted, no consent — see [Command target](../../../../docs/command-target.md)

Experimental (requires `--experimental` or `SUPABASE_EXPERIMENTAL=1`): the Management API route is
live but excluded from the generated OpenAPI spec for now, so `packages/api` has no typed operation
for it and the rendered output may change.

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile` |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | to resolve the linked project when `--remote`/`--project-ref` is absent                       |

## Files Written

| Path                                           | Format | When                                                           |
| ---------------------------------------------- | ------ | -------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | always (in `Effect.ensuring`), caches the resolved project ref |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                |

## API Routes

| Method | Path                                            | Auth         | Request body | Response (used fields)                                                                                                                                  |
| ------ | ----------------------------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/analytics/traces/{traceId}` | Bearer token | none         | `{data: [{type: "span", id, attributes: {parent_span_id, service_name, span_name, span_kind, status_code, start_time, duration_ns}}], meta: {partial}}` |

A 200 with an empty `data` array means no spans matched the trace id (not a 404). A 404 from this
route means the project ref itself wasn't found.

## Environment Variables

| Variable                   | Purpose                                                                                        | Required?                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`    | auth token (bypasses credential file/keyring lookup)                                           | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_EXPERIMENTAL`    | enables the command without passing `--experimental`                                           | no                                                      |
| `SUPABASE_API_MAX_RETRIES` | Management API client retries after the first attempt (not used by this command's raw request) | no                                                      |

## Exit Codes

| Code | Condition                                                                          |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | trace found and printed, including when it contains error spans                    |
| `1`  | `TracesMissingTraceIdError` — `--trace-id` not supplied                            |
| `1`  | `TracesNotFoundError` — the response had no spans for that trace id                |
| `1`  | `TracesUnexpectedStatusError` — non-2xx response (e.g. 404 project not found, 5xx) |
| `1`  | `TracesNetworkError` — transport-level failure or response-decode failure          |
| `1`  | `TracesOutputFlagUnsupportedError` — `-o`/`--output` is not supported              |
| `1`  | `AccessTokenRequiredError` — no token in env/keyring/file                          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` (default)

A summary line (shortened trace id, total duration, span count, error span count, UTC start time),
a blank line, an indented span tree with `SPAN`, `START`, `DURATION`, `ID` columns (offsets from the
earliest span; span ids shortened to 8 characters), and — only when the trace has error spans — a
closing line naming the first error span's id. Each span's label is `<span_name> (<service_name>)`.
The slowest non-root span is marked `[slowest]` (`⏱` in a color-capable TTY) and every error span
is marked `[error]` (`✗` in a color-capable TTY). In a color-capable TTY, the span tree uses Unicode
box-drawing glyphs (`├─`, `└─`) and colors error rows red and the slowest row yellow; otherwise it
uses plain two-space indentation with no color and no truncation. In a TTY, long span labels are
truncated to the terminal width with an ellipsis. Span and service names are stripped of control
characters and ANSI escape sequences before printing (customer-controlled data).

### `--output-format json` / `--output-format stream-json`

A single structured payload via `Output.success`:

```json
{
  "trace_id": "…",
  "spans": [
    {
      "type": "span",
      "id": "…",
      "attributes": {
        "parent_span_id": null,
        "service_name": "…",
        "span_name": "…",
        "span_kind": "server",
        "status_code": "ok",
        "start_time": "…",
        "duration_ns": 350000000
      }
    }
  ],
  "partial": true,
  "duration_ms": 350,
  "span_count": 3,
  "error_span_ids": ["…"],
  "slowest_span_id": "…"
}
```

`partial` mirrors the endpoint's own `meta.partial` flag, which the backend currently always sets
to `true` (untagged or sampled-out spans are never included).

### `-o`/`--output`

Not supported; fails with `TracesOutputFlagUnsupportedError` pointing at `--output-format
json|stream-json`.

## Notes

- `--trace-id` is required; trace search does not exist yet. Omitting it fails with a message
  saying so rather than a generic missing-flag parse error.
- A span whose parent is missing, self-referential, or part of a cycle in the response is rendered
  as an additional root instead of being dropped.
- `end_time` isn't returned by the endpoint; it's derived as `start_time + duration_ns`.
- This route is excluded from the generated OpenAPI spec; once it's published, delete
  `traces.api.ts`'s hand-written request and schema and call the generated `packages/api`
  operation instead, updating this file's API Routes section to match.
