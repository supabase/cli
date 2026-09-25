# `supabase test new <name>`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path                                       | Format | When                                                                         |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| `<workdir>/supabase/tests/<name>_test.sql` | SQL    | if the name is valid, the file does not already exist, and creation succeeds |

The parent directory `<workdir>/supabase/tests/` is created if missing. A name whose path,
with `..` segments collapsed, lands outside that directory is rejected before any
directory or file is created. The check is on the path text: an existing symlink under
`supabase/tests` is followed on purpose, so shared test folders keep working.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                                    |
| ---- | -------------------------------------------- |
| `0`  | success                                      |
| `1`  | invalid test name (escapes `supabase/tests`) |
| `1`  | test file already exists                     |
| `1`  | write failure (e.g. permission denied)       |

## Output

### `--output-format text`

Prints `Created new <template> test at <bold relative-path>.` to stdout, where the
path is the project-relative `supabase/tests/<name>_test.sql`.

### `--output-format json`

Emits a single success object: `{ "path": "supabase/tests/<name>_test.sql", "template": "pgtap" }`.

### `--output-format stream-json`

Emits the same success payload as a final NDJSON `result` event.

## Notes

- Creates a new pgTAP test file scaffold from the embedded template (109 bytes,
  byte-identical to the original Go template).
- `--template` / `-t` selects the template framework (only `pgtap` is supported; default `pgtap`).
- Native TypeScript port (Phase 1+); no Go proxy.
- **Path-traversal hardening (TS-only):** the name is rejected before any write if
  `<workdir>/supabase/tests/<name>_test.sql` lands outside the tests directory once
  `..` segments are collapsed. Nothing is created — no file and no parent directory.
  Existing symlinks under `supabase/tests` are followed on purpose (shared test
  folders), so the check blocks `..` traversal only. Names that stay inside
  `supabase/tests`, optionally with subdirectories, are unaffected.
