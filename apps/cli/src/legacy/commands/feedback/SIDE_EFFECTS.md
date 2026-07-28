# `supabase feedback [message...]`

Alias: `supabase btw [message...]`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

The submitter is intentionally a local stub until the backend destination for
CLI feedback is decided (CLI-1946). Add the API route row when the real
submitter layer replaces `feedbackSubmitterStubLayer`.

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

Agent-detection env vars (e.g. `CLAUDECODE`) are read indirectly by
`@vercel/detect-agent` via `aiToolLayer` to set the submission's
`isAgent`/`agentName` context. Global telemetry consent env applies as with
every command.

## Exit Codes

| Code | Condition                                                            |
| ---- | -------------------------------------------------------------------- |
| `0`  | success                                                              |
| `1`  | no message from args, piped stdin, or an interactive prompt          |
| `1`  | submitter failure (unreachable with the stub; wired for the backend) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

The feedback message content is NEVER included in any telemetry event: the
message is a positional argument, which `extractChangedFlagNames` structurally
excludes from the `flags` property (it only scans `-`-prefixed argv tokens).
Regression-tested in `feedback.integration.test.ts`.

## Output

### `--output-format text`

```
Thanks for the feedback!
```

Rendered as a clack success line. When no message is passed on an interactive
terminal, a "What's on your mind?" text prompt collects it first.

### `--output-format json`

```json
{ "id": "…", "submitted_at": "…", "message": "Thanks for the feedback!" }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"id":"…","submitted_at":"…"},"message":"Thanks for the feedback!"}
```

## Notes

- TS-only command — no Go CLI counterpart, so no Go-parity constraints apply.
- `btw` is a first-class command alias (`Command.withAlias`); telemetry always
  records `command: "feedback"` regardless of which name was invoked.
- Messages starting with a dash need the `--` end-of-options sentinel:
  `supabase feedback -- "--yes should be the default"`.
- Message resolution order: positional args → piped stdin (non-TTY) →
  interactive prompt (TTY, text mode) → error.
- The stub receipt `id` is a locally generated UUID; it does not imply
  server-side persistence.
