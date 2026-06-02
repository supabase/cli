# `supabase telemetry status`

## Files Read

| Path                         | Format | When                                                               |
| ---------------------------- | ------ | ------------------------------------------------------------------ |
| `~/.supabase/telemetry.json` | JSON   | when the file exists, to load the current state before printing it |

When `SUPABASE_HOME` is set, the command uses `$SUPABASE_HOME/telemetry.json`
instead of `~/.supabase/telemetry.json`.

## Files Written

| Path                         | Format | When                                                                                   |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always, because `status` refreshes `session_last_active` and recreates malformed state |

## API Routes

`status` is fully local. No network calls are made.

## Environment Variables

| Variable        | Purpose                                    | Required?                      |
| --------------- | ------------------------------------------ | ------------------------------ |
| `SUPABASE_HOME` | override the telemetry state-file location | no (defaults to `~/.supabase`) |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success                                                                   |
| `1`  | filesystem read/write failure while loading or persisting telemetry state |

Malformed JSON does not fail the command; it is treated as missing state and
replaced with a fresh enabled state.

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

On success, every output mode writes the same raw stdout line:

```text
Telemetry is enabled.
```

or

```text
Telemetry is disabled.
```

If `--output-format json` or `stream-json` is set, only failures are rendered
through the shared JSON error wrapper; successful output remains the plain
stdout line above.

## Notes

- `status` always rewrites the state file, matching Go's
  `telemetry.Status(...)->LoadOrCreateState(...)` path.
- Existing `device_id`, `session_id`, and `distinct_id` fields are preserved
  when the current state file is readable and valid enough to recover them.
