# `supabase telemetry disable`

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
| `cli_command_executed` | when telemetry was **already enabled** before this invocation (see below) |

Go parity (`apps/cli-go/cmd/root.go:131-138,171-181`): the event is gated on
the consent state read at process start, before this command's handler
rewrites `telemetry.json` — not on the value the command just wrote. Running
`disable` while telemetry is enabled fires the event one last time (using
the pre-toggle, still-enabled snapshot); running it while telemetry is
already disabled stays silent. See `telemetry/enable/SIDE_EFFECTS.md` for
the mirror-image case.

When the event fires, the process waits (bounded, up to ~5s) for a PostHog
flush attempt to complete or time out before exiting, since the analytics
client's shutdown is a finalizer around the whole command run. Previously
`disable`/`enable` never queued an event and returned immediately; on a
slow or fully offline network, this invocation can now take noticeably
longer than before, though the `Telemetry is disabled.` stdout line is
still written before that wait (it comes from the handler, which completes
before the surrounding instrumentation's post-run capture/flush step).

## Output

On success, every output mode writes the same raw stdout line:

```text
Telemetry is disabled.
```

If `--output-format json` or `stream-json` is set, only failures are rendered
through the shared JSON error wrapper; successful output remains the plain
stdout line above.

## Notes

- Existing `device_id`, `session_id`, and `distinct_id` fields are preserved
  when the current state file is readable and valid enough to recover them.
- Malformed JSON is treated as missing state and replaced with a fresh disabled
  state, matching `apps/cli-go/internal/telemetry/state.go`.
