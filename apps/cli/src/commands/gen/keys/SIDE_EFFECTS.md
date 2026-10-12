# `supabase gen keys`

Removed and unlisted. The command is a tombstone: it fails with a removal error
and a replacement suggestion instead of contacting the Management API.

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

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                          |
| ---- | ---------------------------------- |
| `1`  | every invocation (removed command) |

## Output

### `--output-format text`

Writes the removal message and the replacement suggestion to stderr, two lines,
regardless of `-o`/`--output`:

```
supabase gen keys was removed.
Use `supabase projects api-keys --project-ref <ref>` to read a project's API keys.
```

### `--output-format json` / `stream-json`

Emits the JSON error envelope on stdout instead of the stderr lines above; the
envelope's `code` is `RemovedSurfaceError` and `suggestion` carries the same
replacement text.

## Telemetry Events Fired

One `cli_command_executed` event per invocation, with `exit_code: 1` and an
`error_fingerprint` ending in `:removed_command` (`RemovedSurfaceError`).

## Notes

- Unlisted (not shown in `supabase gen --help`), still reachable by exact name.
- No flag value is read; the command fails identically regardless of
  `--project-ref`/`--override-name`.
