# `supabase experimental workers new [name]`

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

Workers are recorded in `config.toml` only. The project config loader prefers
`supabase/config.json` when one exists, but the entry writer is a TOML text
editor, so this command pins the loader to `config.toml` (`tomlOnly`). In a
project that has a `config.json`, the worker is therefore written to
`config.toml` — which that loader lists in `ignoredPaths` — and the `config.json`
is left byte-for-byte alone. A rendered edit that would not parse is refused
before anything reaches disk.

`<workdir>` above is exact: the loader is pinned to it (`search: false`, the
same resolver `start`/`stop`/`status` use) and never climbs to an ancestor. A
`--workdir` pointing at a bare directory inside another Supabase project
therefore records the worker in that directory's own `config.toml` — created if
absent — rather than in the ancestor project's.

The name is prompted for when the command line does not carry one, and the
prompt refuses a name that is not a DNS label or that `config.toml` already
records — so nothing is asked, and nothing written, for a name the command was
going to refuse. With `-o json|yaml|toml|env`, a redirected stdout, or a stdin
that is not a terminal, there is nowhere to ask, and the command fails instead
of defaulting: unlike the runtime and size, the name has no default to fall back
on. Every prompt is gated on both streams, so `printf 'api\n' | supabase workers
new` takes that failure path rather than reading the worker name off the pipe.

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

| Code | Condition                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                            |
| `1`  | invalid worker name — the name must be a DNS label                                                 |
| `1`  | no name given, and nowhere to ask for one — stdin or stdout is not a terminal, or `-o` is in force |
| `1`  | bad `--source`: outside the project, or a path the CLI owns                                        |
| `1`  | destination exists and is not empty                                                                |
| `1`  | the worker is already recorded in `config.toml`, in any form                                       |
| `1`  | the rendered `config.toml` would not parse, or `[workers]` is a sealed inline table                |

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

Nothing is emitted for a failure the parser catches, such as a
`--runtime`/`--size` value outside the choice list. The wrapper is installed by
`Command.withHandler`, so a command that never reaches its handler never reaches
the instrumentation either — and `telemetry.json` is not written. A missing name
is _not_ one of those: the argument is optional, so a bare `workers new` reaches
the handler, which asks for the name or fails for want of anywhere to ask.
