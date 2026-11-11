# supabase-config-pull

Write the effective configuration of a remote project or branch into your local `supabase/config.toml` or `config.json`. It is the write side of `supabase config diff`.

Every write is a surgical, format-preserving edit. Comments, key ordering and quoting elsewhere in the file are left untouched, and only the values that change are rewritten.

Pass `--remote=<ref|branch>` to pull from a specific project, or the name (or UUID) of a branch of the currently linked project. Values that are exactly 20 lowercase letters are always treated as project refs. Without `--remote`, the linked project is the target.

`--project-ref` still works in v3 but is deprecated and removed in v4; use `--remote`.

## Where values are written

Where a pulled value lands depends on whether the target is already tracked by a `[remotes.*]` block, not on how you named it. If any block's `project_id` already matches the resolved ref, that block is reused, whatever its own label, and every value lands there.

Otherwise, if the target was named as a branch, a new `[remotes.<branch-name>]` block is created. A branch resolved by UUID falls back to the project ref itself as its label. Creating a new block always writes its `project_id`, even when every other value already matches the local defaults, so that the block can be reused on a later pull.

Only when neither applies do values land at the config root. That happens when `--remote=<ref>` names a project directly, or for the linked project (a bare `--remote` or no flag) with no branch involved.

`--remote-label` overrides the block that would otherwise be reused or created. Naming a block that already tracks a different project, or naming nothing while a different block already tracks this exact ref, is an error rather than a silent overwrite.

A `[remotes.*]` block whose `project_id` is an `env(...)` reference that merely resolves to the target ref is never reused or rewritten. That is a hard error naming the variable, since a value written there would never take effect on the next load.

## Effect on the local stack

Writing to the config root can also affect `supabase start`. A handful of root-scoped settings, such as `auth.site_url`, `db.settings.*`, `db.major_version` (which changes what `supabase start` boots) and `db.pooler.*`, also govern the local stack. Pulling a hosted value into them is a real change to local dev behavior, not just a record of the hosted setting.

`config pull` warns about this rather than refusing. Writing the same value into a `[remotes.*]` block is unaffected, so `--remote-label` is the escape hatch: it diverts a root-bound pull into a `[remotes.<label>]` block and leaves local dev untouched.

## Values that are not written

Several kinds of values are never written, and are reported instead of silently skipped:

- A value whose local declaration resolves from an `env(VAR)` reference. It is reported by variable name; replace the reference yourself, or pass `--remote-label` to target a different block.
- A value the remote itself spells as an `env(VAR)` reference (`remote_env_reference`). The loader would resolve it against the local environment on the next load, so writing it verbatim would let the remote value read whatever this machine's environment holds at that name.
- Secret values, which the platform never returns in plaintext. They are listed in a masked-credentials note.
- A value the file declares that the remote does not report (`local-only`). It is never removed.
- A handful of already-declared properties that `config push` cannot communicate back at all, listed in an unmanaged note.

Local-stack-only sections, such as `[studio]`, `[analytics]`, `[functions]`, `[edge_runtime]`, port numbers and image version pins, have no hosted counterpart and are never touched.

One family of properties is written even though `config push` cannot send it back, for example `auth.oauth_server` and disabled `storage.analytics` or `storage.vector`. Pulling still records the hosted value, with a warning that it cannot be pushed back.

## Keeping the file loadable

`config pull` never writes a `config.toml` or `config.json` that it cannot load back on the next command. Pulling a value that gates other declared fields, such as turning a disabled provider's `enabled` on, also pulls its now-required sibling values in the same write, so the file never comes out half-configured.

When a sibling cannot be supplied, because the remote does not report it or a required value would still be missing, the whole toggle is skipped. It is reported as `requires values pull cannot write` in text output and `would_invalidate` in the machine payload. A note names the missing fields and, when a field is an unresolved `env(VAR)` reference, the environment variable to set before rerunning.

## Confirmation and previews

`--dry-run` prints exactly what `config diff` would show, then stops: no git check, no prompt and no write.

`--output-format json|stream-json` never prompts. It returns the confirmation's default value without reading anything, so use `--dry-run` for a preview in those formats. A non-interactive run in the default text format (no TTY on stdin) still prints the confirmation to stderr and reads a single line from piped stdin. An explicit `y`/`yes`/`n`/`no` is honored, an empty line falls back to the default, and any other answer declines.

`--yes` (or `SUPABASE_YES`) answers the confirmation prompt without asking. It does not bypass the uncommitted-changes guard: `--yes` together with uncommitted or untracked changes aborts instead of silently overwriting them, since no human is left to read the warning.

`--force` writes even when `supabase/config.toml` has uncommitted or untracked changes in git. Without it, an interactive run's prompt defaults to "no" instead of "yes", and every other case (non-interactive text, machine format, or `--yes` on any TTY) aborts outright.

A second `config pull` against an already-tracked, unchanged remote writes nothing, and never checks for uncommitted local changes in that case. A target that is not tracked yet still creates its `[remotes.*]` block on the first pull, even when every value matches the local defaults. It is the second pull against that block that writes nothing.

## Example

Given `supabase/config.toml`:

```toml
project_id = "abcdefghijklmnopqrst"

[api]
enabled = true
max_rows = 1000
```

`supabase config pull --remote=staging`, where `staging` is a branch of the linked project and no existing `[remotes.*]` block already tracks it, creates a new block at the end of the file — `max_rows` lands under its own `[remotes.staging.api]` sub-table, the same way `[api]` itself is a sub-table of the document root, not a key directly under `[remotes.staging]`:

```toml
project_id = "abcdefghijklmnopqrst"

[api]
enabled = true
max_rows = 1000

[remotes.staging]
project_id = "cccccccccccccccccccc"

[remotes.staging.api]
max_rows = 250
```

Running the same command again finds no differences and writes nothing.

Machine-readable output is available through `--output-format json|stream-json`. The payload is versioned and contains `schema_version`, `config_schema`, `config_path`, `format`, `target`, `destination`, `dry_run`, `wrote`, `scope`, `changes[]`, `warnings[]`, `masked[]`, `unmanaged[]` and `counts`.

`target` identifies the pulled project the same way `config diff` does: `kind`, `project_ref`, `project_name`, `environment`, `parent_project_ref`, `branch` and `local_scope`. Per-change `path`s are segment arrays, and each change carries `written` and, when unwritten, a `skipped_reason` (`env_reference | local_only | remote_env_reference | unwritable | would_invalidate | declined | dry_run`).

A `would_invalidate` warning additionally carries `missing_fields` (`[{path, env_variable?}]`) naming what blocked the family. The payload spells the root scope `"base"` (`target.local_scope`), while text output calls the same thing `config root`.

The legacy global `-o`/`--output` flag is not supported by this command; use `--output-format json|stream-json` instead.
