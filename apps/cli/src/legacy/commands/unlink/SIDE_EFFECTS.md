# `supabase unlink`

Native TypeScript port of Go's `internal/unlink`. Operates entirely on local state under
`<workdir>/supabase/.temp/` and the OS keyring — no API calls.

## Files Read

| Path                         | Format     | When                                   |
| ---------------------------- | ---------- | -------------------------------------- |
| `supabase/.temp/project-ref` | plain text | always, to find the linked project ref |

The ref bytes are read **without trimming** — `link` writes the ref with no trailing newline, so the
value round-trips exactly and is reused verbatim for both the stderr message and the keyring key.

## Files Written / Deleted

| Path              | Action              | When                           |
| ----------------- | ------------------- | ------------------------------ |
| `supabase/.temp/` | removed recursively | always (after reading the ref) |

Also deletes the stored **database-password** credential from the OS keyring (service `"Supabase CLI"`,
account = the **project ref**). A missing entry is ignored; the access-token credential is left untouched.

## API Routes

None.

## Environment Variables

None beyond `--workdir` / `SUPABASE_WORKDIR` resolution.

## Exit Codes

| Code | Condition                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | success — project unlinked; prints `Finished supabase unlink.`                                            |
| `1`  | not linked — `supabase/.temp/project-ref` absent (`Cannot find project ref. Have you run supabase link?`) |
| `1`  | project-ref read error                                                                                    |
| `1`  | temp-dir removal error                                                                                    |
| `1`  | keyring delete error other than not-found (e.g. permission denied)                                        |

## Output

### `--output-format text` (Go-compatible)

- stderr: `Unlinking project: <ref>`
- stdout: `Finished supabase unlink.`

### `--output-format json` / `stream-json`

Emits a structured success (`{ project_ref }`) and suppresses the human `Finished` line.

## Known divergence

The `Finished supabase unlink.` line is emitted as **plain text**; Go renders `supabase unlink` in
ANSI cyan via `utils.Aqua`. This matches the established legacy-port convention (color helpers are
rendered plain); ANSI-stripping scripts are unaffected.
