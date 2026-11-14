# `supabase stack prune`

Permanently destroys managed stacks whose project directory no longer exists, for example the
stack of a deleted worktree or a moved project directory. The experimental feature flag controls
command registration.

## Selection and confirmation

Discovery reads the global registry like `stack list`. A stack is selected only when its saved
canonical project root is reported as not found, whatever its branch. A project root that cannot
be checked (for example permission denied) keeps its stack and prints a warning on stderr naming
it. A project on an unmounted volume is reported as not found, so run `--dry-run` first when
projects live on removable or network storage. Registry entries that cannot be read or decoded
are skipped with a warning on stderr, as in `stack list`.

`--dry-run` lists the selected stacks and destroys nothing. Otherwise they are destroyed with the
same cleanup as `stack destroy`: interactive text runs ask once whether to destroy the stacks
listed above, `--yes` skips the question and is required for non-interactive and machine-output
runs, and a stack that fails to be destroyed does not stop the rest. Right before each stack is
destroyed its project root is checked again; a stack whose directory exists again, or can no
longer be checked, is kept with a warning on stderr. A stack that another process destroyed in
the meantime counts as destroyed. Rejection or cancellation destroys nothing, and nothing is
asked when no stack is selected. Explicit legacy `-o/--output` is rejected in favor of
`--output-format`.

## Files and network

Reads `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/state.json`, probes existing local owner control
endpoints and checks whether each saved project root exists. Discovery creates the registry
directory if absent and restricts it to its owner, even with `--dry-run`. Each destroyed stack is
destroyed as `stack destroy` destroys it: its namespace, owned data, port claims and
`stacks/<id>/uploads` are removed, and other stacks are untouched. No hosted API calls are made.
Telemetry flushes to `<SUPABASE_HOME or ~/.supabase>/telemetry.json` on success and failure.

## Output, exit codes and telemetry

Text prints `No stacks found whose project directory no longer exists.` when none is selected.
Otherwise it prints `Found <n> stack(s) whose project directory no longer exists:` and the
`stack list` table of them, then `Stack <id> destroyed.` per destroyed stack. JSON and
stream-json success data contain `dry_run` and `stacks`: the `stack list` entries of the selected
stacks with `--dry-run`, otherwise of the destroyed ones, as found before destruction.

Failures are reported together, even when one stack was selected, with each failed stack in the
error detail. Retryable failures suggest a `supabase stack destroy --stack-id <id> --yes` command;
an upload cleanup failure names the directory to remove instead. The JSON/stream-json error
envelope lists the destroyed stacks in `destroyed_stacks`, including those whose upload cleanup
failed. Exit 0 on success, including when none is selected or every selected stack is kept; 1 on
invalid flags, registry failure, rejected or cancelled confirmation, an unreachable engine, or
cleanup failure; 130 on interruption. Standard command telemetry is unchanged, with no custom
events.
