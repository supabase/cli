# `supabase db query`

Implemented in `query.handler.ts`. Executes SQL against the local
database (direct connection), a `--db-url` database (direct connection) or the linked project
(Management API), then renders the result as a table or JSON.

With no target flag the command follows the workspace target (`SUPABASE_TARGET`, then `target`
in `config.toml`, default `local`; see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md)).
`--local` selects the local stack, `--linked` or `--project-ref` the linked project.

Any statement sent to a hosted target (linked project or remote `--db-url`) asks for one
confirmation first, because the command cannot tell a read from a write. `--read-only` skips that
confirmation and makes the statement unable to write (see Notes). The local stack never prompts.

## Files Read

| Path                                 | Format     | When                                                                                   |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------- |
| `<path>` (from `--file`)             | SQL        | when `--file` / `-f` is set (takes precedence over arg/stdin)                          |
| stdin                                | SQL        | when piped (not a TTY) and no `--file`/positional SQL                                  |
| `supabase/config.toml`               | TOML       | local / `--db-url` connection resolution                                               |
| `~/.supabase/access-token`           | plain text | a linked target when `SUPABASE_ACCESS_TOKEN` unset                                     |
| `supabase/.temp/project-ref`         | plain text | linked ref resolution — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `supabase/.temp/linked-project.json` | JSON       | a linked target, existence check before the cache write (see below)                    |

## Files Written

| Path                                 | Format | When                                                                                                               |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `supabase/.temp/linked-project.json` | JSON   | linked target, after the query runs, when the file does not already exist and `GET /v1/projects/{ref}` returns 200 |

## API Routes

| Method | Path                                | Auth   | Request body                                                    | Response                                                                                                  |
| ------ | ----------------------------------- | ------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/projects/{ref}/database/query` | Bearer | `{"query":"<sql>"}`, plus `"read_only":true` with `--read-only` | 201, JSON array of row objects (raw — the typed client voids the body, so the linked path uses raw HTTP). |
| GET    | `/v1/projects/{ref}`                | Bearer | —                                                               | 200 → linked-project cache write; any other status → no write. Fired after the query on the linked path.  |

## Environment Variables

| Variable                | Purpose                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | linked-target auth                                                             |
| `SUPABASE_TARGET`       | workspace target when no `--local`/`--linked`/`--db-url` is given              |
| `SUPABASE_YES`          | grants the hosted-target confirmation (shell only; `supabase/.env` is ignored) |
| agent-detection signals | `--agent=auto` (e.g. `CURSOR_*`, `CLAUDECODE`, …) via `@vercel/detect-agent`   |

## Exit Codes

| Code | Condition                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                     |
| `1`  | more than one of `--db-url`/`--linked`/`--local` (`TargetSelectorConflictError`); no SQL provided; empty stdin; unreadable `--file`; linked target without login; query exec failure; non-201 linked status |
| `1`  | `--project-ref` with `--local` or `--db-url` (`TargetProjectRefConflictError`)                                                                                                                              |
| `1`  | hosted target without `--read-only` in a JSON, piped, agent or non-TTY run without `--yes` or a shell `SUPABASE_YES` (`HostedMutationConsentRequiredError`); nothing is sent                                |
| `1`  | `--read-only` with transaction control or a read-only setting change (`DbQueryReadOnlyStatementError`); nothing is sent                                                                                     |
| `1`  | hosted target confirmation declined (`HostedMutationDeclinedError`, `context canceled`); nothing is sent                                                                                                    |

## Output

The query payload goes to **stdout** in every `--output-format` mode (there is no
`--output-format` for `db query`; there is no machine envelope around the
payload). Diagnostics go to **stderr**: the `Target: …` line (linked project
`Target: <name> (<ref>)`, `Target: local stack (<host>:<port>)`, `Target: custom Postgres (<host>)`)
and the confirmation question. DDL/DML with no result columns prints the command tag.

- **table** (default for humans): `olekukonko/tablewriter` v1 box layout, NULL for nil.
- **json**: a plain rows array for humans, or — in agent mode — the untrusted-data
  envelope `{advisory?, boundary, rows, warning}` with a random 16-byte hex
  boundary (`Random`), HTML-escaped, map keys
  sorted. Agent mode additionally runs a best-effort RLS advisory check (local
  path only).

### Agent mode

`--agent yes|no|auto` (global). `yes`/`no` force it; `auto` detects an AI tool
from the environment. Agent mode defaults the format to JSON (table for humans).

## Notes

- **`-o` / `--output`.** The command declares a local `--output`/`-o`
  (`json|table|csv`) that shadows the global flag. The Effect CLI extracts global
  flags from the whole token stream before the leaf parse and builds one tree-wide
  registry, so a second command-scoped `output` global is impossible
  (`Parser.createFlagRegistry` throws on duplicate names). Instead the global
  `OutputFlag` choice is the UNION of every command's `--output` values
  (`env|pretty|json|toml|yaml|table|csv`), and the command wrapper enforces this
  command's own enum (`json|table|csv`, declared via `outputFormats` in
  `query.command.ts`):
  - `-o json` selects JSON, `-o table` an ASCII table, `-o csv` CSV; an explicit
    value always wins. With no `-o`, the default is JSON for agents and a table for
    humans.
  - Values outside the `json|table|csv` enum (`pretty|yaml|toml|env`) are rejected
    before the handler runs with the fixed diagnostic text — `invalid argument "yaml" for
"-o, --output" flag: must be one of [ json | table | csv ]` — and exit 1,
    See `output-formats.ts`.
- **Local DDL command tags** use the raw `commandComplete` protocol tag (so
  `CREATE TABLE` etc. survive node-postgres' first-word-only parse of the tag).
- **Target selection.** `--db-url`, `--linked` and `--local` are mutually exclusive and a `false`
  switch counts as absent. `--project-ref` selects the linked project and supplies only the ref
  (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`) for the connection and the linked-project
  cache; combining it with `--local` or `--db-url` is a hard error.
- **Hosted consent.** A linked project or remote `--db-url` asks once, after the SQL is known and
  before it is sent: `Run a SQL statement`, with the statement (collapsed to one line, at most 120
  characters) as the detail and default No. A shell `SUPABASE_YES` or `--yes` grants it
  (`Confirmed by --yes: …`); a `SUPABASE_YES` in `supabase/.env` and a piped answer do not. Stdin
  is never read for the answer. Reading a missing SQL source (no SQL, empty stdin, unreadable
  `--file`) fails before the question.
- **`--read-only`.** Skips the hosted confirmation entirely and prints no question. A linked
  target sends `"read_only": true` in the Management API request, so the server rejects writes.
  The local stack and a `--db-url` database run the statement inside `BEGIN READ ONLY` … `ROLLBACK`,
  so Postgres rejects writes. On every target, before the statement is sent or any question is asked, the
  SQL is split into statements and any whose leading keywords (after whitespace, a BOM and comments)
  are `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ABORT`, `ROLLBACK`, `PREPARE TRANSACTION`,
  `SET TRANSACTION`, `SET SESSION CHARACTERISTICS`, `RESET ALL`, or a `SET`/`SET SESSION`/`SET LOCAL`/
  `RESET` of `transaction_read_only` or `default_transaction_read_only` fails with
  `DbQueryReadOnlyStatementError` naming only that keyword. Keywords inside strings, dollar quotes
  and comments, and reads such as `SELECT set_config(...)`, pass.
- **Linked-project cache.** On the `--linked` path,
  after the query runs — whether it succeeds or fails — the handler issues
  `GET /v1/projects/{ref}` and writes `supabase/.temp/linked-project.json`. The
  write is skipped when the file already exists (`supabase link` is authoritative),
  the access token is missing, or the GET is non-200 — so an auth-failing query
  still fires the GET but writes nothing. `--local` / `--db-url` never resolve a
  project ref and so never trigger this request or write. Shared with `backups`
  via `LinkedProjectCache`.
