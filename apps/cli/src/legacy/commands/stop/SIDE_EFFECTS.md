# `supabase stop`

## Files Read

| Path                             | Format | When                                     |
| -------------------------------- | ------ | ---------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to resolve project configuration |

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

| Code | Condition                                     |
| ---- | --------------------------------------------- |
| `0`  | success — all containers stopped              |
| `1`  | Docker daemon not running or connection error |

## Output

### `--output-format text` (Go CLI compatible)

Prints "Stopped supabase local development setup." on success.

### `--output-format json`

Not applicable — stop is a local-dev workflow command.

### `--output-format stream-json`

Not applicable — stop is a local-dev workflow command.

## Notes

- `--no-backup` deletes all data volumes after stopping.
- `--project-id` targets a specific local project ID to stop.
- `--all` stops all local Supabase instances across all projects on the machine.
- `--project-id` and `--all` are mutually exclusive.
- The hidden `--backup` flag (default true) is the inverse of `--no-backup`.
