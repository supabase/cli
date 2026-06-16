# `supabase db query`

Native TypeScript port (`query.handler.ts`). Executes SQL against the local
database (direct connection) or the linked project (Management API), then renders
the result as a table or JSON.

## Files Read

| Path                                 | Format     | When                                                          |
| ------------------------------------ | ---------- | ------------------------------------------------------------- |
| `<path>` (from `--file`)             | SQL        | when `--file` / `-f` is set (takes precedence over arg/stdin) |
| stdin                                | SQL        | when piped (not a TTY) and no `--file`/positional SQL         |
| `supabase/config.toml`               | TOML       | local / `--db-url` connection resolution                      |
| `~/.supabase/access-token`           | plain text | `--linked` when `SUPABASE_ACCESS_TOKEN` unset                 |
| `supabase/.temp/linked-project.json` | JSON       | `--linked` existence check before the cache write (see below) |

## Files Written

| Path                                 | Format | When                                                                                                            |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| `supabase/.temp/linked-project.json` | JSON   | `--linked`, after the query runs, when the file does not already exist and `GET /v1/projects/{ref}` returns 200 |

## API Routes

| Method | Path                                | Auth   | Request body        | Response                                                                                                     |
| ------ | ----------------------------------- | ------ | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/projects/{ref}/database/query` | Bearer | `{"query":"<sql>"}` | 201, JSON array of row objects (raw — the typed client voids the body, so the linked path uses raw HTTP).    |
| GET    | `/v1/projects/{ref}`                | Bearer | —                   | 200 → linked-project cache write; any other status → no write. Fired after the query on the `--linked` path. |

## Environment Variables

| Variable                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | `--linked` auth                                                              |
| agent-detection signals | `--agent=auto` (e.g. `CURSOR_*`, `CLAUDECODE`, …) via `@vercel/detect-agent` |

## Exit Codes

| Code | Condition                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                             |
| `1`  | conflicting `--db-url`/`--linked`/`--local`; no SQL provided; empty stdin; unreadable `--file`; `--linked` without login; query exec failure; non-201 linked status |

## Output

The query payload goes to **stdout** in every `--output-format` mode (Go has no
`--output-format` for `db query`; there is no machine envelope around the
payload). Diagnostics (`Connecting to {local|remote} database...`) go to
**stderr**. DDL/DML with no result columns prints the command tag.

- **table** (default for humans): `olekukonko/tablewriter` v1 box layout, NULL for nil.
- **json**: a plain rows array for humans, or — in agent mode — the untrusted-data
  envelope `{advisory?, boundary, rows, warning}` with a random 16-byte hex
  boundary (`Random`), HTML-escaped exactly like Go's `json.Encoder`, map keys
  sorted. Agent mode additionally runs a best-effort RLS advisory check (local
  path only).

### Agent mode

`--agent yes|no|auto` (global). `yes`/`no` force it; `auto` detects an AI tool
from the environment. Agent mode defaults the format to JSON (table for humans).

## Notes / Divergences

- **`-o` / `--output`.** Go registers a command-local `--output`/`-o`
  (`json|table|csv`) that shadows the global flag. The Effect CLI extracts global
  flags from the whole token stream before the leaf parse and builds one tree-wide
  registry, so a second command-scoped `output` global is impossible
  (`Parser.createFlagRegistry` throws on duplicate names). Instead the global
  `LegacyOutputFlag` choice is the UNION of every command's `--output` values
  (`env|pretty|json|toml|yaml|table|csv`), and the command wrapper enforces this
  command's own Go enum (`json|table|csv`, declared via `outputFormats` in
  `query.command.ts`):
  - `-o json` selects JSON, `-o table` an ASCII table, `-o csv` CSV; an explicit
    value always wins. With no `-o`, the default is JSON for agents and a table for
    humans (`cmd/db.go:316-325`).
  - Values outside the `json|table|csv` enum (`pretty|yaml|toml|env`) are rejected
    before the handler runs with Go's pflag message — `invalid argument "yaml" for
"-o, --output" flag: must be one of [ json | table | csv ]` — and exit 1,
    matching Go's per-command enum validation. See `legacy-go-output-flag.ts`.
- **Local DDL command tags** use the raw `commandComplete` protocol tag (so
  `CREATE TABLE` etc. survive node-postgres' first-word-only parse of the tag).
- **Linked-project cache (`PersistentPostRun` parity).** On the `--linked` path,
  after the query runs — whether it succeeds or fails — the handler mirrors Go's
  `ensureProjectGroupsCached` (`apps/cli-go/cmd/root.go:176,214-234`): it issues
  `GET /v1/projects/{ref}` and writes `supabase/.temp/linked-project.json`. The
  write is skipped when the file already exists (`supabase link` is authoritative),
  the access token is missing, or the GET is non-200 — so an auth-failing query
  still fires the GET but writes nothing. `--local` / `--db-url` never resolve a
  project ref and so never trigger this request or write (Go gates on
  `flags.ProjectRef != ""`). Shared with `backups` via `LegacyLinkedProjectCache`.
