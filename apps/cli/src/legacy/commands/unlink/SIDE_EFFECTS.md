# `supabase unlink`

## Files Read

| Path                     | Format | When                                           |
| ------------------------ | ------ | ---------------------------------------------- |
| `.supabase/project.json` | JSON   | to retrieve stored project ref before deletion |

## Files Written

| Path                     | Format | When               |
| ------------------------ | ------ | ------------------ |
| `.supabase/project.json` | —      | deleted on success |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                | Required? |
| ----------------------- | ---------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN` | not consumed by unlink | no        |

## Exit Codes

| Code | Condition                                                            |
| ---- | -------------------------------------------------------------------- |
| `0`  | success — project unlinked                                           |
| `0`  | project unlinked without stored database credentials (keyring empty) |
| `1`  | not linked — no `.supabase/project.json` found (`ErrNotLinked`)      |
| `1`  | permission denied removing the project state file                    |

## Output

### `--output-format text` (Go CLI compatible)

No output on success (exits 0 silently). Error messages go to stderr.

### `--output-format json`

Not applicable — unlink produces no JSON output.

### `--output-format stream-json`

Not applicable — unlink produces no structured output.

## Notes

- Removes the project ref from `.supabase/project.json` (and the legacy `supabase/.temp/project-ref` path).
- Also removes any stored database password for the project from the OS keyring.
- If the keyring entry does not exist (`ErrNotFound`), the command still succeeds.
- No API calls are made; this is a purely local operation.
