# `supabase experimental workers delete <name>`

> **No live test yet.** `workers` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Workers routes are available on that stack.

## Files Read

| Path                                          | Format     | When                                                                                                                                                                            |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`              | JSON       | when present — preferred over `config.toml`; the source directory it kept. Best-effort: a config that will not load degrades to "nothing local" rather than failing the command |
| `<workdir>/supabase/config.toml`              | TOML       | when no `config.json` exists — the same, on the same best-effort terms                                                                                                          |
| `<worker source>/`                            | directory  | canonicalised and stat'd, to decide whether the kept-source line is stated at all                                                                                               |
| `<SUPABASE_HOME or ~/.supabase>/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring holds no credential                                                                                                       |
| `<workdir>/supabase/.temp/project-ref`        | plain text | when neither `--project-ref` nor `SUPABASE_PROJECT_ID` is set — names the linked project                                                                                        |
| `<SUPABASE_HOME or ~/.supabase>/profile`      | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                                                                            |
| `<SUPABASE_PROFILE>` (YAML)                   | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command                                                                     |

## Files Written

| Path                                            | Format | When                                                            |
| ----------------------------------------------- | ------ | --------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                      |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after the project ref resolves, when the cache does not hold it |

The worker's directory and its `[workers.<name>]` entry are deliberately left
on disk; only the remote worker is deleted.

## Confirmation

Interactively, the worker's name has to be typed back before anything is
deleted. `--yes` (the root persistent flag) or `SUPABASE_YES` skips that. With
neither — and no interactive terminal to prompt on, which includes a redirected
stdout and any `--output-format json`/`stream-json` run — the command refuses
rather than deleting unasked.

## API Routes

| Method   | Path                                | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                            |
| -------- | ----------------------------------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | `instances.live` when present, else `spec.instances` (for the confirmation). A `403` is tolerated: the worker is treated as unknown and the `DELETE` still runs, since the two endpoints are granted separately (`edge_functions:read` vs `edge_functions:write`) |
| `DELETE` | `/v2/projects/{ref}/workers/{name}` | Bearer token | none         | status only                                                                                                                                                                                                                                                       |
| `GET`    | `/v1/projects`                      | Bearer token | none         | `id`, `name`, `organization_slug`, `region` — only when no ref resolved and the session is interactive, to populate the project picker                                                                                                                            |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success (a `404` on DELETE counts — it is already gone)                   |
| `0`  | nothing deployed under that name, with `--yes` (teardown is idempotent)   |
| `1`  | invalid worker name                                                       |
| `1`  | nothing deployed under that name, without `--yes`                         |
| `1`  | the typed confirmation did not match the worker's name                    |
| `1`  | confirmation needed but no interactive terminal to ask on, and no `--yes` |
| `1`  | API error, or project not enrolled in the alpha                           |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                        |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)          |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)           |
| `SUPABASE_PROJECT_ID`   | project ref, consulted after `--project-ref`         | no (falls back to `supabase/.temp/project-ref`, then the picker) |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)           |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                   | no (falls back to `~/.supabase`)                                 |
| `SUPABASE_YES`          | auto-confirms the deletion, as `--yes` does          | no (defaults to prompting)                                       |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.

## Output Formats

| Mode                          | stdout                                                                                        | stderr                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| text (default)                | the confirmation prompt, then what was deleted and kept                                       | that nothing local was kept when nothing was, and the redeploy hint |
| `--output-format json`        | one structured result carrying `worker_name`, `project_ref`, `kept_*`                         | as above                                                            |
| `--output-format stream-json` | the same result as a single terminal event                                                    | as above                                                            |
| `-o json` / `yaml` / `toml`   | the same payload in that encoding, and nothing else                                           | as above                                                            |
| `-o pretty` / `table` / `csv` | the text rendering — these fall through rather than encoding                                  | as above                                                            |
| `-o env`                      | refused **before** the DELETE; discovering it at emit time deleted the worker and then failed | the error                                                           |
