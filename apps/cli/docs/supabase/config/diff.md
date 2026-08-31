# supabase-config-diff

Shows the configuration differences between the local `supabase/config.toml` and the effective configuration of a remote project or branch. Read-only: it never modifies the local file or any remote configuration.

Pass `--project-ref` to compare against a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target. When the target ref matches a `[remotes.*]` block's `project_id`, that block's merged config is the local side of the comparison.

Each difference is classified as `update` (the file declares a value that differs remotely), `remote-only` (the remote differs while the file is silent — the shown local value is the schema default a `config push` would write), or `local-only` (the file declares a value the remote did not report). `(unset)` means the local side has no value at all; `(not returned)` means the response did not carry the property. Secret values are never compared — the platform only reports digests — and are listed in a masked-credentials note instead, as are declared properties that `config push` cannot communicate.

Local values are shown as the configuration your file would produce once pushed, not its literal spelling: a duration written as `"1m"` renders as `"1m0s"`, and byte sizes are shown in the units you wrote.

With `--exit-code`, the command exits `2` when any difference is found, keeping exit `1` for errors — so scripts can distinguish drift from failure. Machine-readable output is available through `--output-format json|stream-json` (a versioned payload with per-change paths as segment arrays) or the global `-o json|yaml|toml|env` flag.
