# `supabase experimental stack list`

Lists persisted managed local stacks discovered in the global stack registry.
The command includes stopped stacks and performs no config loading, owner RPC,
activation, or lifecycle mutation.

Entries are sorted by project root, stack name, and id. Text output includes the
identity, project root, branch context, runtime, and desired lifecycle. Structured
output returns the same fields under `stacks`. The legacy `-o/--output` flag is
rejected; use `--output-format json`.
