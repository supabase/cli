# `supabase db remote commit`

Removed. The command is a tombstone: it fails with a removal error and a
replacement suggestion instead of connecting to any database.

## Files Read

| Path                                            | Format | When                                     |
| ----------------------------------------------- | ------ | ---------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always (post-run `TelemetryState.flush`) |

## Files Written

| Path                                            | Format | When                                                                                       |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always (post-run `TelemetryState.flush`), created if missing, even with telemetry disabled |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable        | Purpose                            | Required?                      |
| --------------- | ---------------------------------- | ------------------------------ |
| `SUPABASE_HOME` | directory holding `telemetry.json` | no (defaults to `~/.supabase`) |

## Exit Codes

| Code | Condition                          |
| ---- | ---------------------------------- |
| `1`  | every invocation (removed command) |

## Output

### `--output-format text`

Writes the removal message and the replacement suggestion to stderr, two lines,
regardless of `-o`/`--output`:

```
supabase db remote commit was removed.
Use `supabase db pull --remote` instead.
```

### `--output-format json` / `stream-json`

Emits the JSON error envelope on stdout instead of the stderr lines above; the
envelope's `code` is `RemovedSurfaceError` and `suggestion` carries the same
replacement text.

## Telemetry Events Fired

One `cli_command_executed` event per invocation, with `exit_code: 1` and an
`error_fingerprint` ending in `:removed_command` (`RemovedSurfaceError`).

## Notes

- No flag value is read; the command fails identically regardless of
  `--schema`/`--db-url`/`--linked`/`--password`.
