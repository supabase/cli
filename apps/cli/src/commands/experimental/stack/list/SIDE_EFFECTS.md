# `supabase stack list`

Lists persisted managed local stacks discovered in the global stack registry. The command is
available only when the `experimental.stack` feature family is enabled; the same family gate
controls help and completion. It includes stopped and unconfigured stacks and performs no project
config loading, owner RPC, activation, or lifecycle mutation.

Family selection uses `SUPABASE_EXPERIMENTAL_STACK=1`, or when that variable is
unset/empty, `[experimental].stack = true` in the nearest project `config.toml`
or `config.json`. An explicit `0` disables the family; an explicit `1` enables it.
Invalid environment values fail selection; unreadable or invalid config falls back
to disabled. Config discovery occurs before command help and completion. Stack
start/stop/destroy use the same family gate.

Entries are sorted by project root, stack name, and id. Text output includes the
identity, project root, branch context, runtime, and desired lifecycle. Structured
output returns the same fields under `stacks`. The legacy `-o/--output` flag is
rejected; use `--output-format json`. Discovery is fail-whole-list when a
persisted entry is corrupt or unsupported.

The command reads `${SUPABASE_HOME ?? $HOME/.supabase}/managed/stacks/<stack-id>/`.
Exit code 0 indicates success; exit code 1 indicates a registry read error or
rejected legacy output flag.
