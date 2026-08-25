# `supabase workers new <name>`

> **Local-disk only.** Nothing is deployed and no Management API route is
> called; `workers push` is what talks to the platform.

## Files Read

| Path                                     | Format     | When                                                                                                        |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`         | TOML       | always — decoded to refuse a worker that is already recorded, then re-read as text to append the new entry  |
| `<destination>/`                         | dir        | always, to refuse a destination that is not empty                                                           |
| `<SUPABASE_HOME or ~/.supabase>/profile` | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`        |
| `<SUPABASE_PROFILE>` (YAML)              | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command |

## Files Written

| Path                                            | Format | When                                                                       |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML   | on success — appends `[workers.<name>]`, preserving surrounding formatting |
| `<workdir>/supabase/workers/<name>/*`           | varies | on success, unless `--source` names another directory                      |
| `<workdir>/<source>/*`                          | varies | on success, when `--source` is given                                       |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | whenever the handler runs — flushed on success and on failure              |

Writes to `config.toml` are append-only. A worker already recorded under
`[workers.<name>]` is refused outright — before the runtime and size prompts,
and before anything reaches disk — because editing an entry the user owns is
not this command's job.

Nothing at the destination is ever removed or overwritten: a destination that
exists and is not empty is refused, and clearing it is left to the user.
`--source` is refused when it resolves to the project root, `supabase/`,
`supabase/functions/`, `supabase/migrations/`, or outside the project. Symlinks
are resolved first, so a path inside the project that points outside it is
refused too. A relative `--source` is resolved against the directory the command
was run in; a `source` recorded in `config.toml` is resolved against the project
root.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Exit Codes

| Code | Condition                                                    |
| ---- | ------------------------------------------------------------ |
| `0`  | success                                                      |
| `1`  | invalid worker name — the name must be a DNS label           |
| `1`  | bad `--source`: outside the project, or a path the CLI owns  |
| `1`  | destination exists and is not empty                          |
| `1`  | the worker is already recorded in `config.toml`, in any form |

## Environment Variables

| Variable           | Purpose                                 | Required?                                              |
| ------------------ | --------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_PROFILE` | built-in profile name or YAML file path | no (falls back to `~/.supabase/profile` -> `supabase`) |
| `SUPABASE_WORKDIR` | project directory the command acts on   | no (falls back to `--workdir`, then the ancestor walk) |
| `SUPABASE_HOME`    | directory holding `telemetry.json`      | no (falls back to `~/.supabase`)                       |

## Telemetry Events Fired

| Event                  | When                                           | Notable properties / groups         |
| ---------------------- | ---------------------------------------------- | ----------------------------------- |
| `cli_command_executed` | post-handler, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.

Nothing is emitted for a failure the parser catches, such as a missing worker
name or a `--runtime`/`--size` value outside the choice list. The wrapper is
installed by `Command.withHandler`, so a command that never reaches its handler
never reaches the instrumentation either — and `telemetry.json` is not written.
