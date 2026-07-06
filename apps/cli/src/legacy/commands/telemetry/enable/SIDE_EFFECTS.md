# `supabase telemetry enable`

## Files Read

| Path                         | Format | When                                                                        |
| ---------------------------- | ------ | --------------------------------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | when the file exists, to preserve prior identity fields before rewriting it |

When `SUPABASE_HOME` is set, the command uses `$SUPABASE_HOME/telemetry.json`
instead of `~/.supabase/telemetry.json`.

## Files Written

| Path                         | Format | When   |
| ---------------------------- | ------ | ------ |
| `~/.supabase/telemetry.json` | JSON   | always |

## API Routes

None called directly. `cli_command_executed` may be sent to PostHog — see
Telemetry Events Fired below.

## Environment Variables

| Variable        | Purpose                                    | Required?                      |
| --------------- | ------------------------------------------ | ------------------------------ |
| `SUPABASE_HOME` | override the telemetry state-file location | no (defaults to `~/.supabase`) |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success                                                                   |
| `1`  | filesystem read/write failure while loading or persisting telemetry state |

## Telemetry Events Fired

| Event                  | When                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `cli_command_executed` | when telemetry was **already enabled** before this invocation (see Notes) |

Go parity (`apps/cli-go/cmd/root.go:131-138,171-181`): the event is gated on
the consent state read at process start, before this command's handler
rewrites `telemetry.json` — not on the value the command just wrote. In the
common case (enabling from a disabled state) the pre-toggle snapshot is
`false`, so nothing fires; running `enable` while telemetry is already
enabled fires the event, matching Go's uniform, state-based (not
command-based) gate. See `telemetry/disable/SIDE_EFFECTS.md` for the
mirror-image case.

## Output

On success, every output mode writes the same raw stdout line:

```text
Telemetry is enabled.
```

If `--output-format json` or `stream-json` is set, only failures are rendered
through the shared JSON error wrapper; successful output remains the plain
stdout line above.

## Notes

- Existing `device_id`, `session_id`, and `distinct_id` fields are preserved
  when the current state file is readable and valid enough to recover them.
- Malformed JSON is treated as missing state and replaced with a fresh enabled
  state, matching `apps/cli-go/internal/telemetry/state.go`.
