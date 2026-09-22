# `supabase db branch <create|delete|list|switch>`

Single shared side-effect document for all four `db branch` leaves. Local database
branches are no longer supported; each leaf is a tombstone that fails with a
removal error and a replacement suggestion instead of performing any work.

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
supabase db branch <leaf> was removed.
Local database branches are no longer supported. For hosted preview branches, see `supabase branches --help`.
```

### `--output-format json` / `stream-json`

Emits the JSON error envelope on stdout instead of the stderr lines above; the
envelope's `code` is `RemovedSurfaceError` and `suggestion` carries the same
replacement text.

## Telemetry Events Fired

One `cli_command_executed` event per invocation, with `exit_code: 1` and an
`error_fingerprint` ending in `:removed_command` (`RemovedSurfaceError`).

## Notes

- `create`/`delete`/`switch` accept an optional `<branch name>` positional so a bare
  invocation still reaches the tombstone (and emits telemetry) instead of failing
  parse with a missing-argument error.
- No positional or flag value is read; every leaf fails identically regardless of
  its arguments.
- `supabase branches --help` covers the hosted preview-branching product this
  suggestion points to, which is a different product from local DB branches, not a
  drop-in replacement.
