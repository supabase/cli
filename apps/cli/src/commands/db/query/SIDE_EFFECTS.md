# `supabase db query`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

Implemented in `query.handler.ts`. Executes SQL against the local
database (direct connection), a `--remote=<url>` database (direct connection) or a remote project
or branch (Management API), then renders the result as a table or JSON.

Any statement sent to a hosted target (remote project, branch or remote `--remote=<url>`) asks for one
confirmation first, because the command cannot tell a read from a write. `--read-only` skips that
confirmation and accepts only read statements in a read-only transaction (see Notes). The local
stack never prompts.

## Files Read

| Path                                 | Format     | When                                                                                                                                          |
| ------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `<path>` (from `--file`)             | SQL        | when `--file` / `-f` is set (takes precedence over arg/stdin)                                                                                 |
| stdin                                | SQL        | when piped (not a TTY) and no `--file`/positional SQL                                                                                         |
| `supabase/config.toml`               | TOML       | local / `--remote=<url>` connection resolution                                                                                                |
| `~/.supabase/access-token`           | plain text | a remote project or branch when `SUPABASE_ACCESS_TOKEN` unset                                                                                 |
| `supabase/.temp/project-ref`         | plain text | bare `--remote`, ref resolution — skipped when `SUPABASE_PROJECT_ID` is set; with no selector, only to name the project in the `Target:` hint |
| `supabase/.temp/linked-project.json` | JSON       | a remote project or branch, existence check before the cache write (see below)                                                                |

## Files Written

| Path                                 | Format | When                                                                                                                          |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `supabase/.temp/linked-project.json` | JSON   | remote project or branch, after the query runs, when the file does not already exist and `GET /v1/projects/{ref}` returns 200 |

## API Routes

| Method | Path                                | Auth   | Request body                                                    | Response                                                                                                                                                                                                              |
| ------ | ----------------------------------- | ------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/projects/{ref}/database/query` | Bearer | `{"query":"<sql>"}`, plus `"read_only":true` with `--read-only` | 201, JSON array of row objects (read via `executeRaw`, since the typed operation voids the body).                                                                                                                     |
| GET    | `/v1/projects/{ref}`                | Bearer | —                                                               | 200 → linked-project cache write; any other status → no write. Fired after the query on a remote project or branch.                                                                                                   |
| GET    | `/v1/projects/{parent}/branches`    | Bearer | —                                                               | 200 → `[{id, name, project_ref}]`. Branch lookup — only for `--remote=<branch>`, and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project. |
| GET    | `/v1/branches/{id}`                 | Bearer | —                                                               | 200 → `{ref, status, …}`. Branch lookup — only for `--remote=<branch UUID>` when no project is linked                                                                                                                 |

## Environment Variables

| Variable                | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | auth for a remote project or branch                                                                                      |
| `SUPABASE_PROJECT_ID`   | linked project ref override and the parent that `--remote=<branch>` is resolved against (superseded by `--remote=<ref>`) |
| `SUPABASE_YES`          | grants the hosted-target confirmation (shell only; `supabase/.env` is ignored)                                           |
| agent-detection signals | `--agent=auto` (e.g. `CURSOR_*`, `CLAUDECODE`, …) via `@vercel/detect-agent`                                             |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                   |
| `1`  | no SQL provided; empty stdin; unreadable `--file`; remote project or branch without login; query exec failure; non-201 remote status                                                                                                      |
| `1`  | hosted target without `--read-only` in a JSON, piped, agent or non-TTY run without `--yes` or a shell `SUPABASE_YES` (`HostedMutationConsentRequiredError`); nothing is sent                                                              |
| `1`  | `--read-only` with a statement that does not start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` or `(`, or with input that ends inside a comment, quote or dollar quote (`DbQueryReadOnlyStatementError`); nothing is sent |
| `1`  | hosted target confirmation declined (`HostedMutationDeclinedError`, `context canceled`); nothing is sent                                                                                                                                  |

## Output

The query payload goes to **stdout** in every `--output-format` mode (there is no
`--output-format` for `db query`; there is no machine envelope around the
payload). Diagnostics go to **stderr**: alias deprecation warnings, the `Target:` line
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
- **Hosted consent.** A remote project, branch or remote `--remote=<url>` asks once, after the SQL is known and
  before it is sent: `Run a SQL statement`, with the statement (collapsed to one line, at most 120
  characters) as the detail and default No. Reading a missing SQL source (no SQL, empty stdin, unreadable
  `--file`) fails before the question.
- **`--read-only`.** Skips the hosted confirmation entirely and prints no question. On every
  target, before the statement is sent or any question is asked, the SQL is split into statements
  and each must start (after whitespace, a BOM and comments) with `SELECT`, `WITH`, `VALUES`,
  `TABLE`, `SHOW`, `EXPLAIN` or `(` (a parenthesised query). Any other statement (`COMMIT`, `SET`, `CALL`, `DO`, `COPY`, `LOCK`,
  …), input that ends inside a comment, quote or dollar quote, and input that contains a
  `BEGIN ATOMIC` function body (the splitter reads such a body as one statement) fails with
  `DbQueryReadOnlyStatementError`, naming only the leading keyword or a fixed label. Keywords
  inside strings, dollar quotes and comments, `BEGIN ATOMIC` inside a string literal, quoted
  identifier, dollar quote or comment (`select 'begin atomic'`), and reads such as
  `SELECT set_config(...)`, pass the checks. A remote project or branch sends `"read_only": true` in the Management API request, and the
  API enforces it. The local stack and a `--remote=<url>` database run the statement inside
  `BEGIN READ ONLY`, `SET LOCAL lock_timeout = '5s'`, the statement, then `ROLLBACK`, so Postgres
  rejects writes and the read cannot queue behind heavy locks (there is no `statement_timeout`).
  What it does not cover: a function with side effects called from a read statement, such as
  `pg_terminate_backend` or `dblink_exec`, still runs.
- **Linked-project cache.** On a remote project or branch,
  after the query runs — whether it succeeds or fails — the handler issues
  `GET /v1/projects/{ref}` and writes `supabase/.temp/linked-project.json`. The
  write is skipped when the file already exists (`supabase link` is authoritative),
  the access token is missing, or the GET is non-200 — so an auth-failing query
  still fires the GET but writes nothing. The local default and `--remote=<url>` never resolve a
  project ref and so never trigger this request or write. Shared with `backups`
  via `LinkedProjectCache`.
