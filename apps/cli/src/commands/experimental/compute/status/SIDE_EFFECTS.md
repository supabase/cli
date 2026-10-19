# `supabase compute status <name>`

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

| Path                                          | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`              | JSON       | when present — preferred over `config.toml`; the compute's source directory. Best-effort: a config that will not load degrades to "nothing local" rather than failing the command. An explicit `--workdir`/`SUPABASE_WORKDIR` is read exactly as given, with no ancestor search; with a DEFAULTED workdir the loader may resolve an ancestor project's `config.json` from a subdirectory (CLI-2285), and the reported source directory resolves against that SAME ancestor root |
| `<workdir>/supabase/config.toml`              | TOML       | when no `config.json` exists — the same, on the same best-effort terms, with the same explicit-vs-default workdir rule                                                                                                                                                                                                                                                                                                                                                          |
| `<compute source>/`                           | directory  | canonicalised and stat'd, to decide whether the source row is stated at all                                                                                                                                                                                                                                                                                                                                                                                                     |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set — names the linked project                                                                                                                                                                                                                                                                                                                                                                                       |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                                                                                                                                                                                                                                                                                                                                                                            |
| `<SUPABASE_PROFILE>` (YAML)                   | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command                                                                                                                                                                                                                                                                                                                                                                     |

## Files Written

| Path                                            | Format | When                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                                                                                                                                                                                        |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once the project ref has resolved (success or failure), only when no such file exists, `<workdir>/supabase/.temp/project-ref` doesn't name another ref, an access token exists and `GET /v1/projects/{ref}` returns 200 |

## API Routes

| Method | Path                                | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/compute/{name}` | Bearer token | none         | `spec`, `build_state`, `state_reason`, `image_version`, `instances`, `instances_error`, `deleting`                                                                                                                                                                                              |
| `GET`  | `/v1/projects`                      | Bearer token | none         | `id`, `name`, `organization_slug`, `region` — only when no ref resolved and the session is interactive, to populate the project picker                                                                                                                                                          |
| `GET`  | `/v1/projects/{ref}`                | Bearer token | none         | `ref`, `name`, `organization_id`, `organization_slug` — linked-project cache miss only (best-effort, post-run): written only when `<workdir>/supabase/.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |
| `GET`  | `/v1/projects/{parent}/branches`    | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                                        |
| `GET`  | `/v1/branches/{id}`                 | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                                                                |

## Exit Codes

| Code | Condition                                       |
| ---- | ----------------------------------------------- |
| `0`  | success                                         |
| `1`  | invalid compute name                            |
| `1`  | nothing deployed under that name                |
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

| Mode                          | stdout                                                                                                 | stderr                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| text (default)                | the details block                                                                                      | an unreadable instance tally, and the build-retry hint on a failure |
| `--output-format json`        | one structured result carrying every reported field                                                    | neither — both are text-only                                        |
| `--output-format stream-json` | the same result as a single terminal event                                                             | neither — both are text-only                                        |
| `-o json` / `yaml` / `toml`   | the same payload in that encoding, and nothing else                                                    | neither — both are text-only                                        |
| `-o pretty` / `table` / `csv` | the text rendering — these fall through rather than encoding                                           | both, as in text                                                    |
| `-o env`                      | refused before any request; the payload nests an instance tally a flat `KEY=value` list cannot express | the error                                                           |

A structured emission is the end of the run: the handler returns at
`emitComputeMachineOutput` or at `output.success`, so nothing in the text
branch below it — the instance tally and the build-retry trailer — is reached.
`-o pretty`, `table` and `csv` are the exception, since they encode nothing and
fall through to that same text branch.

## Notes

- Targets the linked project unless `--remote=<ref>` is given; a bare `--remote` also targets the linked project. `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked project (by name or UUID, resolved through `GET /v1/projects/{parent}/branches`, or `GET /v1/branches/{id}` for a UUID when no project is linked), or `true|yes|on|1` for the linked project. A database URL is rejected (`supabase experimental compute status` takes a project, not a database); `false|no|off|0` and `--no-remote` fail with `--remote doesn't take false. Leave it out to use the linked project.`, and an empty value with `--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to use the linked project.`
- A bare `--remote` followed by a word that exactly matches a branch of the linked project, is within a small edit distance of one, or can't be checked because the branch listing failed stops the run before any other work with an error that names the cause (an HTTP status, or a missing or invalid access token) and offers both readings without echoing the word: `--remote=<branch>` for the branch, the command's operands then `--remote` for the linked project. Any other word runs as the operand.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` and prints a deprecation warning on stderr that names the replacement; it cannot be combined with `--remote=<value>`. An empty `--project-ref` is rejected.
