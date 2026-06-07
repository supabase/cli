# `supabase start`

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
| `0`  | success — all containers started              |
| `1`  | malformed config                              |
| `1`  | Docker daemon not running or connection error |
| `1`  | one or more containers failed health check    |

## Output

### `--output-format text` (Go CLI compatible)

Streams Docker pull and container start progress to stdout. Prints service URLs on success.

### `--output-format json`

Not applicable — start is a local-dev workflow command.

### `--output-format stream-json`

Not applicable — start is a local-dev workflow command.

## Notes

- `--exclude` / `-x` flag accepts a comma-separated list of container names to skip.
- `--ignore-health-check` suppresses unhealthy container errors and exits 0.
- `--preview` is a hidden flag to connect to a feature preview branch.
- If all containers are already running the command shows status instead.
