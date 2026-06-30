# `supabase migration new`

## Files Read

| Path    | Format   | When                                        |
| ------- | -------- | ------------------------------------------- |
| `stdin` | SQL text | when piped stdin is detected (non-TTY mode) |

## Files Written

| Path                                                   | Format   | When                              |
| ------------------------------------------------------ | -------- | --------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql` | SQL text | always — creates a new empty file |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — migration file created                                |
| `1`  | invalid migration name (resolves outside `supabase/migrations`) |
| `1`  | failed to create migrations directory                           |
| `1`  | failed to write migration file                                  |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Created new migration at <bold supabase/migrations/<timestamp>_<name>.sql>` to
stdout. The path is **workdir-relative** (Go chdir's into `--workdir`, so the printed
path is independent of the resolved project root).

### `--output-format json`

Emits `output.success("Migration created", { path })` where `path` is the absolute
path of the created file. No human-readable line is written.

### `--output-format stream-json`

Same structured result as `json`, delivered as an NDJSON `result` event.

## Notes

- Requires exactly one positional argument: the migration name.
- The file timestamp uses the current UTC time in `YYYYMMDDHHMMSS` format.
- If stdin is piped (non-TTY), the raw bytes are written verbatim into the new
  migration file, including any trailing newline. A TTY (or an empty pipe) writes an
  empty file.
- The file is written with mode `0644`.
- **Path-traversal hardening (TS-only):** the name is rejected before any write if
  `<workdir>/supabase/migrations/<timestamp>_<name>.sql` resolves outside the
  migrations directory (e.g. a `..`-laden name). Go has no such check; the guard is
  parity-neutral for legitimate names (simple identifiers) and only closes the
  arbitrary-write vector (CWE-22) when the name is attacker/template-controlled.
