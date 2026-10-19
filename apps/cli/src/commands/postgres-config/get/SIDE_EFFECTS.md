# `supabase postgres-config get`

## Files Read

| Path                                           | Format                    | When                                                                                                                                                               |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                         |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write                                                          |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are both unset, and as the linked parent for `--remote=<branch>`; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` - on success and failure. Not written if the gate is closed.                                                                                                                                             |

## API Routes

| Method | Path                                          | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                                | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`  | `/v1/projects/{parent}/branches`              | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none         | full JSON object                                                                                                                                                                                                                                         |
| `GET`  | `/v1/projects/{ref}`                          | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                      | no (falls back to keyring -> `~/.supabase/access-token`)                                      |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                                   | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag                                                                  | no (pass `--experimental` instead; one of the two is required)                                |

## Exit Codes

| Code | Condition                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success - Postgres config printed                                                                                                                                                                              |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) - checked before ref resolution/API/telemetry                                                                      |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError`; `InvalidProjectRefError` for a malformed `SUPABASE_PROJECT_ID` or link-file ref)                                                                           |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | API non-2xx (`PostgresConfigGetUnexpectedStatusError`)                                                                                                                                                         |
| `1`  | transport failure (`PostgresConfigGetNetworkError`); the GET retries on 5xx and transport errors first                                                                                                         |
| `1`  | response body is not a JSON object (`PostgresConfigGetUnmarshalError`)                                                                                                                                         |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → `<redacted>`) |

## Output

In text mode, a `- Custom Postgres Config -` heading is written to stderr, the config table is rendered to stdout, then `- End of Custom Postgres Config -` is written to stderr.

### `--output-format text` (default)

Renders the config map as an ASCII table with `Parameter` / `Value` columns.

### `--output pretty`

Identical to text mode.

### `--output json`

Indented JSON with alphabetical key order and a trailing newline.

### `--output yaml`

YAML representation of the config map.

### `--output toml`

TOML representation of the config map. Numeric config values render with a `.0` suffix for whole numbers (for example `max_connections = 100.0`).

### `--output env`

Flat `KEY="value"` lines for each config entry.

### `--output-format json`

Single `success` event whose data is the full config object.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- The `--output` flag wins over `--output-format` when both are provided.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `.temp/linked-project.json` is written after ref resolution (once the `--experimental` gate is open), even when the API call fails, but only on a cache miss with a token when `GET /v1/projects/{ref}` succeeds and `.temp/project-ref` does not name another ref. A closed gate writes nothing.
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- `postgres-config` is an experimental command: `get` requires `--experimental`
  (or `SUPABASE_EXPERIMENTAL`), checked before the login check. A closed gate exits 1
  before project-ref resolution, the API call, the `linked-project.json` write, the
  `telemetry.json` write, and the `cli_command_executed` event.
- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase postgres-config get` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that is a branch of the linked project fails before any
  other work with a `Did you mean --remote=<word>?` hint, since the word may have been meant as
  the flag's value.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
