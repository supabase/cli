# `supabase remotes list`

TS-only command, no Go equivalent — see `docs/go-cli-divergences.md`.

## Files Read

| Path                                              | Format    | When   |
| ------------------------------------------------- | --------- | ------ |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON | always |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

—

## Environment Variables

| Variable           | Purpose                        | Required? |
| ------------------ | ------------------------------ | --------- |
| `SUPABASE_WORKDIR` | resolves the project directory | no        |

## Exit Codes

| Code | Condition                                     |
| ---- | --------------------------------------------- |
| `0`  | success (including an empty registry)         |
| `1`  | no `supabase/config.toml`/`config.json` found |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

```
NAME     PROJECT REF
staging  abcdefghijklmnopqrst
```

### `--output-format json`

```json
{ "remotes": [{ "name": "staging", "project_ref": "abcdefghijklmnopqrst" }] }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"remotes":[{"name":"staging","project_ref":"abcdefghijklmnopqrst"}]}}
```

## Notes

- Pure config read — never touches the network (V17).
- Reads the POST-`env()`-interpolation document, so an `env(REF)`-valued
  `project_id` shows its resolved ref, not the literal `env(...)` string.
