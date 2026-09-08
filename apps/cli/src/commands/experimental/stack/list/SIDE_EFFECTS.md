# `supabase stack list`

Lists persisted managed local stacks discovered in the global stack registry.
The command includes stopped stacks and performs no config loading, owner RPC,
activation, or lifecycle mutation. Registry discovery is currently fail-fast: a
corrupt or unsupported entry can prevent other entries from being listed.

Entries are sorted by project root, stack name, and id. Text output includes the
identity, project root, branch context, runtime, and desired lifecycle. Structured
output returns the same fields under `stacks`. The legacy `-o/--output` flag is
rejected; use `--output-format json`.

The command reads `${SUPABASE_HOME ?? $HOME/.supabase}/managed/stacks/<stack-id>/`,
including each persisted state document and state remnant metadata. It consumes
`SUPABASE_HOME`, falling back to `HOME/.supabase`. Exit code 0 indicates success;
exit code 1 indicates a registry read error or rejected legacy output flag.
