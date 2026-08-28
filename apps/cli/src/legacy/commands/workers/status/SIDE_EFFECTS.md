# `supabase workers status <name>`

> **No live test yet.** `workers` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Workers routes are available on that stack.

## Files Read

| Path                                          | Format     | When                                                                                                                                                                             |
| --------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`              | JSON       | when present — preferred over `config.toml`; the worker's source directory. Best-effort: a config that will not load degrades to "nothing local" rather than failing the command |
| `<workdir>/supabase/config.toml`              | TOML       | when no `config.json` exists — the same, on the same best-effort terms                                                                                                           |
| `<worker source>/`                            | directory  | canonicalised and stat'd, to decide whether the source row is stated at all                                                                                                      |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential                                                                                                        |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--project-ref` nor `SUPABASE_PROJECT_ID` is set — names the linked project                                                                                         |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                                                                             |
| `<SUPABASE_PROFILE>` (YAML)                   | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command                                                                      |

## Files Written

| Path                                            | Format | When                                                            |
| ----------------------------------------------- | ------ | --------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                      |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after the project ref resolves, when the cache does not hold it |

## API Routes

| Method | Path                                | Auth         | Request body | Response (used fields)                                                                                                                 |
| ------ | ----------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | `spec`, `build_state`, `state_reason`, `image_version`, `instances`, `instances_error`, `deleting`                                     |
| `GET`  | `/v1/projects`                      | Bearer token | none         | `id`, `name`, `organization_slug`, `region` — only when no ref resolved and the session is interactive, to populate the project picker |

## Exit Codes

| Code | Condition                                       |
| ---- | ----------------------------------------------- |
| `0`  | success                                         |
| `1`  | invalid worker name                             |
| `1`  | nothing deployed under that name                |
| `1`  | API error, or project not enrolled in the alpha |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                        |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)          |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)           |
| `SUPABASE_PROJECT_ID`   | project ref, consulted after `--project-ref`         | no (falls back to `supabase/.temp/project-ref`, then the picker) |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)           |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                   | no (falls back to `~/.supabase`)                                 |

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
| `--output-format json`        | one structured result carrying every reported field                                                    | as above                                                            |
| `--output-format stream-json` | the same result as a single terminal event                                                             | as above                                                            |
| `-o json` / `yaml` / `toml`   | the same payload in that encoding, and nothing else                                                    | as above                                                            |
| `-o pretty` / `table` / `csv` | the text rendering — these fall through rather than encoding                                           | as above                                                            |
| `-o env`                      | refused before any request; the payload nests an instance tally a flat `KEY=value` list cannot express | the error                                                           |
