# `supabase compute list`

## Feature gate

This command is registered only when `experimental.compute` is enabled. Set
`SUPABASE_EXPERIMENTAL_COMPUTE=1` to enable it, or `0` to disable it; an unset
or empty variable uses the project configuration. Any non-boolean value
reports an invalid feature-flag value before command parsing. When disabled, it is absent from
help and completion; direct invocation follows the normal unknown-command path
and the command handler does not run. See the [Compute command guide](../../../../../docs/compute-commands.md).

> **No live test yet.** `compute` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Compute routes are available on that stack.

## Files Read

| Path                                          | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`              | JSON       | always when present — preferred over `config.toml`; the `[compute.*]` entries. An explicit `--workdir`/`SUPABASE_WORKDIR` is read exactly as given, with no ancestor search; with a DEFAULTED workdir the loader may resolve an ancestor project's `config.json` from a subdirectory (CLI-2285), and `supabase/compute/` below resolves against that SAME ancestor root, never the invoking directory's own |
| `<workdir>/supabase/config.toml`              | TOML       | always when no `config.json` exists — the same entries, with the same explicit-vs-default workdir rule                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/compute/`                 | directory  | always — enumerated and each child stat'd, so a directory with no `[compute.<name>]` entry still appears in the inventory. Absent reads as no compute; any other read failure fails the command                                                                                                                                                                                                             |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential                                                                                                                                                                                                                                                                                                                                   |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set — names the linked project                                                                                                                                                                                                                                                                                                                   |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                                                                                                                                                                                                                                                                                                        |
| `<SUPABASE_PROFILE>` (YAML)                   | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command                                                                                                                                                                                                                                                                                                 |

## Files Written

| Path                                            | Format | When                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                                                                                                                                                                                        |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once the project ref has resolved (success or failure), only when no such file exists, `<workdir>/supabase/.temp/project-ref` doesn't name another ref, an access token exists and `GET /v1/projects/{ref}` returns 200 |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/compute`     | Bearer token | none         | `data[].id`, `data[].attributes.spec/build_state/deleting`                                                                                                                                                                                                                                      |
| `GET`  | `/v1/projects`                   | Bearer token | none         | `id`, `name`, `organization_slug`, `region` — only when no ref resolved and the session is interactive, to populate the project picker                                                                                                                                                          |
| `GET`  | `/v1/projects/{ref}`             | Bearer token | none         | `ref`, `name`, `organization_id`, `organization_slug` — linked-project cache miss only (best-effort, post-run): written only when `<workdir>/supabase/.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                                        |
| `GET`  | `/v1/branches/{id}`              | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                                                                |

## Exit Codes

| Code | Condition                                       |
| ---- | ----------------------------------------------- |
| `0`  | success, including when the project has none    |
| `1`  | API error, or project not enrolled in the alpha |

## Environment Variables

| Variable                        | Purpose                                                                                                                                         | Required?                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_EXPERIMENTAL_COMPUTE` | command registration (boolean `1`/`true` enables, `0`/`false` disables; unset/empty uses `experimental.compute`; non-boolean values are errors) | no                                                                                                                                                                                                                                    |
| `SUPABASE_ACCESS_TOKEN`         | auth token (bypasses credential file/keyring lookup)                                                                                            | no (falls back to keyring → `~/.supabase/access-token`)                                                                                                                                                                               |
| `SUPABASE_PROFILE`              | built-in profile name or YAML file path                                                                                                         | no (falls back to `~/.supabase/profile` -> `supabase`)                                                                                                                                                                                |
| `SUPABASE_PROJECT_ID`           | project ref, consulted after `--remote=<ref>`                                                                                                   | no (falls back to `supabase/.temp/project-ref`, then the picker)                                                                                                                                                                      |
| `SUPABASE_WORKDIR`              | project directory the command acts on                                                                                                           | no (falls back to `--workdir`, then the ancestor walk) — read exactly as given when SET (flag or env), with **no ancestor search**; a DEFAULTED workdir may still resolve an ancestor project's config from a subdirectory (CLI-2285) |
| `SUPABASE_HOME`                 | directory holding `telemetry.json`                                                                                                              | no (falls back to `~/.supabase`)                                                                                                                                                                                                      |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.

## Output Formats

| Mode                          | stdout                                                                                                   | stderr                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| text (default)                | the inventory table                                                                                      | notes about deployed compute with no entry or source |
| `--output-format json`        | one structured result carrying `project_ref`, `compute`                                                  | as above                                             |
| `--output-format stream-json` | the same result as a single terminal event                                                               | as above                                             |
| `-o json` / `yaml` / `toml`   | the same payload in that encoding, and nothing else                                                      | as above                                             |
| `-o pretty` / `table` / `csv` | the text rendering — these fall through rather than encoding                                             | as above                                             |
| `-o env`                      | refused before any request; the payload carries a `compute` array a flat `KEY=value` list cannot express | the error                                            |

The text table omits each compute's URL — it is the same host and prefix on
every row, and carrying it made the table 137 columns wide. Every machine
format still carries `url` per compute, and `compute status` renders it.

## Notes

- Targets the linked project unless `--remote=<ref>` is given; a bare `--remote` also targets the linked project. `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked project (by name or UUID, resolved through `GET /v1/projects/{parent}/branches`, or `GET /v1/branches/{id}` for a UUID when no project is linked), or `true|yes|on|1` for the linked project. A database URL is rejected (`supabase experimental compute list` takes a project, not a database); `false|no|off|0`, `--no-remote` and an empty value fail with `Leave out --remote to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` and prints a deprecation warning on stderr that names the replacement; it cannot be combined with `--remote=<value>`. An empty `--project-ref` is rejected.
