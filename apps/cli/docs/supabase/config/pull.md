# supabase-config-pull

Writes the effective configuration of a remote project or branch into the local `supabase/config.toml`/`config.json` — the write side of `supabase config diff`. Every write is a surgical, format-preserving edit: comments, key ordering, and quoting elsewhere in the file are left untouched, and only the values that actually change are rewritten.

Pass `--project-ref` to pull from a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target.

Where a pulled value lands depends on whether the target is already tracked by a `[remotes.*]` block, not on how you named it: if any block's `project_id` already matches the resolved ref, that block is reused — whatever its own label — and every value lands there. Otherwise, if the target was named as a branch, a new `[remotes.<branch-name>]` block is created (a branch resolved by UUID falls back to the project ref itself as its label). Only when neither applies — a bare `--project-ref` naming a project directly, or the linked project with no branch involved — do values land at the config root. `--remote-label` overrides the block config pull would otherwise reuse or create; naming a block that already tracks a different project, or naming nothing while a different block already tracks this exact ref, is an error rather than a silent overwrite. A `[remotes.*]` block whose `project_id` is an `env(...)` reference that merely _resolves_ to the target ref is never reused or rewritten — that is a hard error naming the variable, since a value written there would never actually take effect on the next load. Creating a new block always writes its `project_id`, even when every value it would otherwise carry already matches the local defaults — otherwise the block could never be reused on a later pull.

Writing to the config root can also affect `supabase start`: a handful of root-scoped settings — `auth.site_url`, `db.settings.*`, `db.pooler.*`, and similar — also govern the local stack, so pulling a hosted value into them is a real change to local dev behavior, not just a record of the hosted project's own setting. `config pull` warns about this rather than refusing; writing the same value into a `[remotes.*]` block is unaffected.

Several kinds of values are never written, and are reported instead of silently skipped: a value whose local declaration resolves from an `env(VAR)` reference (reported by variable name — replace the reference yourself, or pass `--remote-label` to target a different block); secret values, which the platform never returns in plaintext (a masked-credentials note); a value the file declares that the remote does not report (`local-only` — never removed); and a handful of already-declared properties `config push` cannot communicate back at all (an unmanaged note). Local-stack-only sections — `[studio]`, `[analytics]`, `[functions]`, `[edge_runtime]`, port numbers, image version pins, and similar — have no hosted counterpart and are never touched. One family of properties is written despite `config push` having no way to send it back (`auth.oauth_server`, disabled `storage.analytics`/`storage.vector`, …) — pulling still records the hosted value, with a warning that it cannot be pushed back.

`--dry-run` computes and prints exactly what `config diff` would show, then stops — no git check, no prompt, no write. `--yes` (or `SUPABASE_YES`) answers the confirmation prompt without asking; it does not bypass the uncommitted-changes guard. `--force` writes even when `supabase/config.toml` has uncommitted changes in git — without it, an interactive run's prompt defaults to "no" instead of "yes", and a non-interactive or machine-format run aborts outright.

A second `config pull` against an already-tracked, unchanged remote always writes nothing — that convergence is the design's own acceptance property, not a special case. It never even checks for uncommitted local changes to the config file in that case, since there is nothing to write either way. A target that isn't tracked yet (a branch or `--remote-label` name with no existing `[remotes.*]` block) still creates that block on its first pull, even when every value it carries already matches the local defaults — it's the second pull against that now-tracked block that then writes nothing.

## Example

Given `supabase/config.toml`:

```toml
project_id = "abcdefghijklmnopqrst"

[api]
enabled = true
max_rows = 1000
```

`supabase config pull --project-ref staging`, where `staging` is a branch of the linked project and no existing `[remotes.*]` block already tracks it, creates a new block at the end of the file:

```toml
project_id = "abcdefghijklmnopqrst"

[api]
enabled = true
max_rows = 1000

[remotes.staging]
project_id = "cccccccccccccccccccc"
max_rows = 250
```

Running the same command again finds no differences and writes nothing.

Machine-readable output is available through `--output-format json|stream-json` — a versioned payload (`schema_version`, `config_schema`, `config_path`, `format`, `target`, `destination`, `dry_run`, `wrote`, `scope`, `changes[]`, `warnings[]`, `masked[]`, `unmanaged[]`, `counts`) with per-change `path`s as segment arrays, each carrying `written` and, when unwritten, a `skipped_reason`. The legacy global `-o`/`--output` flag is not supported by this command; use `--output-format json|stream-json` instead.
