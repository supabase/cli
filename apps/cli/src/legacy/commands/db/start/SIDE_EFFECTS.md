# `supabase db start`

## Files Read

| Path                             | Format | When                               |
| -------------------------------- | ------ | ---------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to resolve local DB config |
| `<path>` (from `--from-backup`)  | binary | when `--from-backup` flag is set   |

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

| Code | Condition                      |
| ---- | ------------------------------ |
| `0`  | success                        |
| `1`  | Docker not running             |
| `1`  | database container start error |

## Output

### `--output-format text` (Go CLI compatible)

Prints progress to stderr as the local Postgres container starts.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--from-backup` restores the database from a logical backup file on start.
