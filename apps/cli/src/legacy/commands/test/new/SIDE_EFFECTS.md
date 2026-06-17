# `supabase test new <name>`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path                                       | Format | When                                   |
| ------------------------------------------ | ------ | -------------------------------------- |
| `<workdir>/supabase/tests/<name>_test.sql` | SQL    | always, unless the file already exists |

The parent directory `<workdir>/supabase/tests/` is created if missing.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                              |
| ---- | -------------------------------------- |
| `0`  | success                                |
| `1`  | test file already exists               |
| `1`  | write failure (e.g. permission denied) |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Created new <template> test at <bold relative-path>.` to stdout, where the
path is the project-relative `supabase/tests/<name>_test.sql` (matches Go's
`fmt.Printf` in `apps/cli-go/internal/test/new/new.go:31`).

### `--output-format json`

Emits a single success object: `{ "path": "supabase/tests/<name>_test.sql", "template": "pgtap" }`.

### `--output-format stream-json`

Emits the same success payload as a final NDJSON `result` event.

## Notes

- Creates a new pgTAP test file scaffold from the embedded template (109 bytes,
  byte-identical to Go's `templates/pgtap.sql`).
- `--template` / `-t` selects the template framework (only `pgtap` is supported; default `pgtap`).
- Native TypeScript port (Phase 1+); no Go proxy.
