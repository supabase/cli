# `supabase remotes add <name> --project-ref <ref>`

TS-only command, no Go equivalent — see `docs/go-cli-divergences.md`.

## Files Read

| Path                                              | Format    | When   |
| ------------------------------------------------- | --------- | ------ |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON | always |

## Files Written

| Path                                              | Format    | When                                                                                                                                                                            |
| ------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON | on success, when the name/ref pair is new — TOML gets an APPEND-ONLY `[remotes.<name>]` block; JSON gets a structural, order-preserving key insert. Atomic (tmp file + rename). |

## API Routes

—

## Environment Variables

| Variable           | Purpose                        | Required? |
| ------------------ | ------------------------------ | --------- |
| `SUPABASE_WORKDIR` | resolves the project directory | no        |

## Exit Codes

| Code | Condition                                                                                 |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | success, including a no-op re-add of an identical name/ref pair                           |
| `1`  | no config file found; invalid name; invalid ref; name already exists with a DIFFERENT ref |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

```
Added remote "staging" -> abcdefghijklmnopqrst.
```

### `--output-format json`

```json
{ "name": "staging", "project_ref": "abcdefghijklmnopqrst", "wrote": true }
```

## Notes

- Never goes through `saveProjectConfig`'s full schema re-serialize — that
  would strip comments/formatting from the rest of the file. TOML edits are
  append-only; every byte before the append offset is untouched.
- Idempotent: re-adding the same name with the identical ref is a no-op,
  exit 0.
