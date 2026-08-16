# `supabase remotes remove <name>`

TS-only command, no Go equivalent — see `docs/go-cli-divergences.md`.

## Files Read

| Path                                              | Format    | When   |
| ------------------------------------------------- | --------- | ------ |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON | always |

## Files Written

| Path                                              | Format    | When                                                                               |
| ------------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON | on success — deletes the `[remotes.<name>]` block/key. Atomic (tmp file + rename). |

## API Routes

—

## Environment Variables

| Variable           | Purpose                        | Required? |
| ------------------ | ------------------------------ | --------- |
| `SUPABASE_WORKDIR` | resolves the project directory | no        |

## Exit Codes

| Code | Condition                                                                                 |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | success                                                                                   |
| `1`  | no config file found; name not found; block declares config beyond `project_id` (refused) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

```
Removed remote "staging".
```

### `--output-format json`

```json
{ "name": "staging" }
```

## Notes

- Refuses to remove a `[remotes.<name>]` block that declares keys beyond
  `project_id` — deleting it would silently drop hand-authored remote-specific
  config. Delete those keys first.
- Removing the last remote never leaves a stray empty `[remotes]` table
  (TOML) or `"remotes": {}` (JSON).
