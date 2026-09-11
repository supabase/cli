# `supabase compute new [name]`

## Feature gate

This command is registered only when `experimental.compute` is enabled. Set
`SUPABASE_EXPERIMENTAL_COMPUTE=1` to enable it, or `0` to disable it; an unset
or empty variable uses the project configuration. Any other non-empty value
reports an invalid feature-flag value before command parsing. When disabled, it is absent from
help and completion; direct invocation follows the normal unknown-command path
and the command handler does not run. See the [Compute command guide](../../../../../docs/compute-commands.md).

> **Local-disk only.** Nothing is deployed and no Management API route is
> called; `compute push` is what talks to the platform.

## Files Read

| Path                                     | Format     | When                                                                                                                                                          |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`         | TOML       | when present and no authoritative JSON config was found — decoded to check existing entries, then read as text for the edit                                   |
| `<workdir>/supabase/config.json`         | JSON       | writer checks existence/selection only; the feature gate reads contents when the environment override is unset or empty. Includes defaulted-workdir ancestors |
| `<destination>/`                         | dir        | always, to refuse a destination that is not empty                                                                                                             |
| `<SUPABASE_HOME or ~/.supabase>/profile` | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                                                          |
| `<SUPABASE_PROFILE>` (YAML)              | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command                                                   |

## Files Written

| Path                                            | Format | When                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML   | on success — appends `[compute.<name>]` with `runtime`, `size` and `exposure` always, `instances` only when it differs from the default of 1, and `source` only when `--source` was passed, preserving surrounding formatting |
| `<workdir>/supabase/compute/<name>/*`           | varies | on success, unless `--source` names another directory                                                                                                                                                                         |
| `<workdir>/<source>/*`                          | varies | on success, when `--source` is given                                                                                                                                                                                          |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | whenever the handler runs — flushed on success and on failure                                                                                                                                                                 |

Compute resources are recorded in `config.toml` only. The project config loader prefers
`supabase/config.json` when one exists, but the entry writer is a TOML text
editor. Before prompting or writing, this command refuses a project whose
authoritative configuration is `config.json`, including a JSON-only ancestor
found from a defaulted workdir. It cannot append deployment settings to a TOML
file that readers would ignore. JSON projects can configure Compute entries and
source files manually. A rendered TOML edit that would not parse is refused
before anything reaches disk.

The TOML writer is pinned to `<workdir>` with `search: false`. Before loading
that file, a defaulted workdir also probes ancestor project paths to refuse
JSON-authoritative projects. An explicit `--workdir` or `SUPABASE_WORKDIR`
never searches ancestors: pointing it at a bare directory records the Compute
entry in that directory's own `config.toml`, created if absent.

The name is prompted for when the command line does not carry one, and the
prompt refuses a name that is not a DNS label or that `config.toml` already
records — so nothing is asked, and nothing written, for a name the command was
going to refuse. With `-o json|yaml|toml|env`, a redirected stdout, or a stdin
that is not a terminal, there is nowhere to ask, and the command fails instead
of defaulting: unlike the runtime, size and exposure, the name has no default to
fall back on. Every prompt is gated on both streams, so
`printf 'api\n' | supabase compute new` takes that failure path
rather than reading the compute name off the pipe.

`runtime`, `size` and `exposure` are always written, defaults included: they are
closed sets the command prompts for, and pinning the answer is the point of
recording it. The exposure default follows the runtime — `private` for
`actions-runner`, which only calls out to GitHub, and `public` for every other
runtime — so it is the runtime that decides what an unanswered exposure prompt
records. `instances` is written only when it differs from the default of 1 —
it has no prompt, because how many instances a compute needs is not something a
scaffold can guess, and an absent `instances` means exactly what `instances = 1`
means to `push`. A `0` is an explicit count that scales the compute to nothing, so
it is written like any other. It is rendered as a bare TOML number rather than a
quoted string, because the config schema types it as a number.

Writes to `config.toml` are append-only. A compute already recorded under
`[compute.<name>]` is refused outright — before the dial prompts,
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

| Code | Condition                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                         |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`ComputeNewWorkdirError`) — beats every prompt and filesystem write |
| `1`  | authoritative project config is JSON (`ComputeJsonConfigUnsupportedError`)                                                                      |
| `1`  | invalid compute name — the name must be a DNS label                                                                                             |
| `1`  | no name given, and nowhere to ask for one — stdin or stdout is not a terminal, or `-o` is in force                                              |
| `1`  | bad `--source`: outside the project, or a path the CLI owns                                                                                     |
| `1`  | destination exists and is not empty                                                                                                             |
| `1`  | the compute is already recorded in `config.toml`, in any form                                                                                   |
| `1`  | the rendered `config.toml` would not parse, or `[compute]` is a sealed inline table                                                             |

## Environment Variables

| Variable                        | Purpose                                                                                                                    | Required?                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_EXPERIMENTAL_COMPUTE` | command registration (`1` enable, `0` disable; unset/empty uses `experimental.compute`; other non-empty values are errors) | no                                                     |
| `SUPABASE_PROFILE`              | built-in profile name or YAML file path                                                                                    | no (falls back to `~/.supabase/profile` -> `supabase`) |
| `SUPABASE_WORKDIR`              | project directory the command acts on                                                                                      | no (falls back to `--workdir`, then the ancestor walk) |
| `SUPABASE_HOME`                 | directory holding `telemetry.json`                                                                                         | no (falls back to `~/.supabase`)                       |

## Telemetry Events Fired

| Event                  | When                                           | Notable properties / groups         |
| ---------------------- | ---------------------------------------------- | ----------------------------------- |
| `cli_command_executed` | post-handler, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.

Nothing is emitted for a failure the parser catches, such as a
`--runtime`/`--size`/`--exposure` value outside the choice list, or a negative
`--instances`. The wrapper is installed by
`Command.withHandler`, so a command that never reaches its handler never reaches
the instrumentation either — and `telemetry.json` is not written. A missing name
is _not_ one of those: the argument is optional, so a bare `compute new` reaches
the handler, which asks for the name or fails for want of anywhere to ask.

## Notes

- A non-existent `--workdir`/`SUPABASE_WORKDIR` now fails before any directory or file is created (CLI-2285) — previously a typo'd `--workdir` could scaffold a fresh `supabase/compute/…` tree (plus a new `config.toml`) at the wrong path.
- The `Created new Compute at <path>` line (and the equivalent machine-format `source` field) shows the absolute path when `--workdir`/`SUPABASE_WORKDIR` was set explicitly, since the scaffolded directory is then not necessarily relative to the terminal the command was run from.
