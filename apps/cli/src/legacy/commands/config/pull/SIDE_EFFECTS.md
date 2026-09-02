# `supabase config pull`

Writes the effective configuration of a remote project or branch back into the local
`supabase/config.toml`/`config.json` — the write side of `supabase config diff` (same target
resolution, fetch, and classification, `../diff/`). Prompts for confirmation before writing on an
interactive TTY, unless `--yes` is set; a non-interactive run — no TTY, or `--output-format
json|stream-json` — never prompts at all and proceeds as though confirmed. Never writes on
`--dry-run`, on a declined prompt, or on any error.

## Files Read

| Path                                              | Format                    | When                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON                 | always, before any network call (`loadCliConfig` probes `config.json` first, then `config.toml` — a missing file or parse error aborts, exit 1, naming whichever file actually failed); this first load applies NO `[remotes.*]` overlay, regardless of the eventual target                                                        |
| same file, raw on-disk text                       | TOML/JSON                 | read ONCE, immediately after the load above and before target resolution — the exact bytes `applyConfigEdits` edits later, and the baseline the pre-write re-read below compares against                                                                                                                                           |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON                 | re-loaded WITH the `[remotes.*]` overlay applied, only when the resolved target ref matches an EXISTING block (block reuse selects it as the destination, `remoteNameForProjectRef`) — a brand-new block has nothing to overlay yet, so this second load is skipped in that case                                                   |
| same file, raw on-disk text (TOCTOU re-read)      | TOML/JSON                 | immediately before writing, once the confirmation prompt has been answered — only reached when at least one change is planned and the run is not `--dry-run`; bytes differing from the earlier read abort the write (`LegacyConfigPullFileChangedError`) instead of overwriting a file that changed while the prompt was on screen |
| `<workdir>/supabase/.env`, `.env.local`           | dotenv                    | always, to resolve `env(VAR)` references inside `config.toml`                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/.temp/project-ref`            | plain text                | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file); parent-ref candidate for a branch-name `--project-ref` (checked eagerly, BEFORE any spinner or branch lookup)                                                                                                                                                     |
| `<workdir>/supabase/.temp/linked-project.json`    | JSON                      | parent-ref candidate for a branch-name `--project-ref` (same eager pre-check); existence-checked for the telemetry cache write below                                                                                                                                                                                               |
| `~/.supabase/access-token`                        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                                                                                                                                         |

## Files Written

| Path                                              | Format    | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON | ONLY after the confirmation prompt answers "yes" — `--yes`/`SUPABASE_YES` always answer yes, UNLESS the git dirty guard already aborted first (see Git below — `--yes` never bypasses that guard, on any TTY); otherwise the prompt's default is yes, UNLESS the git dirty guard downgraded it to no (only possible in an interactive TTY text run with no `--yes`) — AND there is at least one value change planned OR a new `[remotes.*]` block would be created (a zero-drift branch/`--remote-label` target still writes the block's own `project_id`, even with no value changes to apply — see Notes). **Never** on `--dry-run`; **never** on a declined prompt; **never** on any error path (including the TOCTOU mismatch above). Written atomically: a temp file in the SAME directory (`<file>.tmp.<Date.now()>.<6-hex-chars>`), the original file's mode copied onto it, then `rename`d over the original; the temp file is removed if anything fails before the rename |
| `<workdir>/supabase/.temp/linked-project.json`    | JSON      | `Effect.ensuring` after run (success **and** failure), if a target ref resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `~/.supabase/telemetry.json`                      | JSON      | `Effect.ensuring` after run (success **and** failure)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Git

- Spawns `git status --porcelain -- <basename>` (cwd set to the config file's own directory) to
  check for uncommitted changes to `supabase/config.toml`/`.json` before writing (the dirty guard)
  — skipped entirely when `--force` is passed (no check, no warning, no prompt-default change), AND
  skipped entirely when the run has nothing to do (no value change planned, no `[remotes.*]` block
  to create — the same condition that short-circuits to "no config differences found" without a
  prompt). A converged run never spawns `git`, no matter what state the working tree is in.
- A non-zero exit, a spawn failure (`git` not installed or not on `PATH`), or the directory not
  being a git working tree all degrade silently to "clean" — same degrade-on-uncertainty policy as
  `detectGitBranch`. No error, no warning.
- A dirty (or untracked, `??`) result changes behavior by output mode: in an interactive TTY text
  run WITHOUT `--yes` it downgrades the confirmation prompt's default answer from yes to no and
  adds a "supabase/config.toml has uncommitted or untracked changes. Commit or stash them (-u for
  untracked), or rerun with --force." warning to the rendered output; every other case — a
  non-interactive or machine-format run, OR `--yes` passed on any TTY — aborts before any prompt
  (`LegacyConfigPullUncommittedChangesError`, exit 1): `--yes` answers a prompt no one asked, it
  never bypasses this guard, since no human is on hand to read the warning either way.

## API Routes

All Bearer-authenticated, all read-only (pull never calls a write endpoint — every change lands
locally via the file write above).

| #   | Purpose                 | Method | Path                                 | Success | Notes                                                                                                                                                                                                     |
| --- | ----------------------- | ------ | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a  | branch by UUID          | GET    | `/v1/branches/{branch_id}`           | 200     | only when `--project-ref` is a UUID; needs no linked project (no parent pre-check)                                                                                                                        |
| 0b  | branch by name          | GET    | `/v1/projects/{ref}/branches/{name}` | 200     | only when `--project-ref` is a NAME (not a ref/UUID); the parent ref is resolved from local state BEFORE this call — an absent/invalid parent fails without making this request; 404 → "branch not found" |
| 1   | effective remote config | GET    | `/v2/projects/{ref}/config`          | 200     | always (after target resolution); 401/403/404 get purpose-written messages, other statuses the generic `unexpected status N: body` shape                                                                  |

## Environment Variables

| Variable                | Purpose                                                                                                                                 | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`   | project ref (flag → this → `.temp/project-ref` → prompt)                                                                                | no                                                      |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                    | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | API profile selection                                                                                                                   | no                                                      |
| `SUPABASE_WORKDIR`      | working directory `config.toml`/`.json` is read from and written to (`--workdir` flag takes priority)                                   | no (defaults to the current directory)                  |
| `SUPABASE_YES`          | answers the confirmation prompt "yes" (same effect as `--yes`); does **not** bypass the uncommitted-changes guard — only `--force` does | no                                                      |
| `env(VAR)` references   | interpolated into `config.toml` values at load; a change whose LOCAL value resolved from `env()` is always skipped, never overwritten   | no                                                      |

## Exit Codes

`config pull` has no `--exit-code` flag (unlike `config diff`) — there is no exit code `2`. A
successful run that finds nothing to write, and a run whose confirmation prompt is declined, both
exit `0`: neither is a failure.

| Code | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — including "no differences found", "differences found but none writable", and a declined confirmation prompt                                                                                                                                                                                                                                                                                                                                                             |
| `1`  | the `-o`/`--output` global flag passed (any value — not supported by this command)                                                                                                                                                                                                                                                                                                                                                                                                |
| `1`  | missing or malformed `supabase/config.toml`/`config.json` (`LegacyConfigPullLoadConfigError`)                                                                                                                                                                                                                                                                                                                                                                                     |
| `1`  | branch-name `--project-ref` with no linked parent project (`LegacyConfigPullBranchNotLinkedError`)                                                                                                                                                                                                                                                                                                                                                                                |
| `1`  | branch-name `--project-ref` with a corrupt/invalid linked parent ref (`LegacyConfigPullParentRefInvalidError`)                                                                                                                                                                                                                                                                                                                                                                    |
| `1`  | unknown branch (branch-name `--project-ref` 404, `LegacyConfigPullBranchNotFoundError`)                                                                                                                                                                                                                                                                                                                                                                                           |
| `1`  | resolved branch has no project ref yet — still provisioning (`LegacyConfigPullBranchNotReadyError`)                                                                                                                                                                                                                                                                                                                                                                               |
| `1`  | `--remote-label`, or a branch-derived label, names an existing block tracking a different project, or a `--remote-label` names nothing while a different block already tracks the target ref (`LegacyConfigPullRemoteLabelCollisionError`)                                                                                                                                                                                                                                        |
| `1`  | the target ref only matches a `[remotes.*]` block's `project_id` via `env(...)` resolution, never its raw literal (`LegacyConfigPullRemoteEnvRefError`)                                                                                                                                                                                                                                                                                                                           |
| `1`  | remote config read failure — network, 401/403/404, or other unexpected status (`LegacyConfigPullReadNetworkError`/`LegacyConfigPullReadStatusError`)                                                                                                                                                                                                                                                                                                                              |
| `1`  | `supabase/config.toml` has uncommitted or untracked changes and no human will read the warning — the run is non-interactive/machine-format, OR `--yes` was passed on any TTY — with no `--force` (`LegacyConfigPullUncommittedChangesError`) — checked ONLY when this run has something to write (a value change, a new `[remotes.*]` block, or both); a converged run with nothing to do never spawns `git` and never reaches this check, regardless of the working tree's state |
| `1`  | the config file changed on disk between the pre-prompt read and the write (`LegacyConfigPullFileChangedError`)                                                                                                                                                                                                                                                                                                                                                                    |
| `1`  | `applyConfigEdits` refused the edit — duplicate table header, an array-of-tables/inline table on the write path, an existing `env(...)` literal at the destination, or a re-parse verification mismatch (`LegacyConfigPullUnsupportedLayoutError`)                                                                                                                                                                                                                                |
| `1`  | the atomic write itself failed — a filesystem permission problem (`LegacyConfigPullWriteError`)                                                                                                                                                                                                                                                                                                                                                                                   |
| `1`  | the post-plan convergence check found a written path still differs from the remote — a defect in this command's own planner, never user-facing; nothing was written (`LegacyConfigPullPlanDefectError`)                                                                                                                                                                                                                                                                           |
| `1`  | the schema-validation gate (ADR 0023 §d) still finds the projected document unloadable after dropping every family it could identify — never user-facing; nothing was written (`LegacyConfigPullValidationFailedError`)                                                                                                                                                                                                                                                           |

## Telemetry Events Fired

| Event                  | When                                                                  | Notable properties / groups                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via `withLegacyCommandInstrumentation`) | `exit_code`, `duration_ms`, `flags`; `--project-ref`'s value is only in `safeFlags` (logged verbatim) when it is ref-shaped (`PROJECT_REF_PATTERN`) — a user-created branch name is redacted; `--remote-label` is never in `safeFlags` |

## Output

Diagnostics on **stderr**: `Pulling config from <target> → <destination>` (the destination echoed
BEFORE any network call — `config root` or `[remotes.<label>]`), then
`Comparison scope: <blocks>` once the response arrives (same line `config diff` prints). The
confirmation prompt and the change-set body are on **stdout**, followed by the payload.

The confirmation prompt itself reads `Apply N change(s) to <path> [remotes.<label>]?` whenever at
least one value change is planned — even when the run ALSO creates a new `[remotes.*]` block —
naming the destination block when writing into one (omitted for the config root), or
`Create [remotes.<label>] in <path>?` for a block-only run (no value changes, just the new block —
a zero-drift branch/`--remote-label` target).

### `--output-format text`

The same per-difference blocks `config diff` renders, now labeled `<path> [class-label,
write|not pulled|skip: reason]` (`class-label` hyphenated — `update`/`remote-only`/`local-only` —
and the skip reason humanized for prose, e.g. `env() reference`, or `requires values pull cannot
write` for `would_invalidate`; a `local-only` change always renders `not pulled` rather than
repeating its own class as a skip reason) with `local:`/`remote:` lines, followed by a
`Warnings:` section when the plan carries any (`dual_scope`, `duplicates_root`, `array_drift`,
`uncommitted_changes`, `unpushable`, `would_invalidate` — the last naming the missing field(s)
that made a whole family unwritable and, when one is itself an unresolved `env(VAR)` reference,
the exact variable to set), a summary count line (`No
config differences found.` when clean, otherwise `N difference(s) found (W to write, S to
skip).`), a `New block [remotes.<label>] will be created (project_id = <ref>).` line whenever the
plan creates a new block — REGARDLESS of whether any value write is also planned, so a block-only
run states its one action in the body too, not only in its own confirmation prompt — and the same
masked/unmanaged/not-returned `Note:` lines as `config diff`. This body is shown BEFORE the
confirmation prompt (and reused unchanged for `--dry-run`). A final one-line disposition follows
once the outcome is known (WITHOUT repeating the body's own `Note:` caveats — those already showed
once): `No config differences found.` (no changes at all, no block to create), `No changes
written.` (differences existed, but every one was skipped), `N change(s) written.`, `N change(s)
would be written (dry run).`, or `N change(s) not written (declined).` — or, for a BLOCK-ONLY run
(no value changes, just the new block): `Created [remotes.<label>]; no config differences to
apply.`, `[remotes.<label>] would be created (dry run); no config differences to apply.`, or
`[remotes.<label>] not created (declined).`

### `--output-format json` / `stream-json`

`output.success(message, payload)`. `schema_version` is this command's OWN payload version
(`LEGACY_CONFIG_PULL_PAYLOAD_VERSION`, currently `1`) — independent of `config diff`'s. The payload
contains `config_schema`, `config_path`, `format`, `target` (`project_ref`, optional `branch`,
`local_scope` — the block the LOCAL comparison operand came from, `"base"` when pulling into a
brand-new `[remotes.*]` block since there is nothing to overlay yet), `destination` (`scope`,
optional `label`, `created` — WHERE this run writes, independent of `target.local_scope`),
`dry_run`, `wrote`, `scope` (`{present, missing}`), `changes[]` (`config diff`'s own change shape
plus `written` and, when unwritten, `skipped_reason`: `env_reference | local_only | unwritable |
would_invalidate | declined | dry_run`; a change with `written: true` ALSO carries
`document_path` — the exact destination-prefixed segment path `applyConfigEdits` wrote to, e.g.
`["remotes", "staging", "api", "max_rows"]` — absent from every unwritten entry, since nothing
landed anywhere for those), `warnings[]` (`{kind, path?, missing_fields?}` — `missing_fields` only
on a `would_invalidate` warning: `[{path, env_variable?}]`, the field(s) the schema-validation gate
found still missing/invalid under that warning's `path`, naming the env var to set when a field's
local spelling is an unresolved `env(VAR)` reference), `masked[]`, `unmanaged[]`, and `counts` (per class + `total`, plus
`written`/`skipped`). `destination.created` means "a `[remotes.*]` block was (or, on `--dry-run` /
a declined prompt, WOULD be) created this run" — it does not by itself say whether anything was
actually written; `wrote` disambiguates that: `wrote` is `true` whenever the run actually changed
the file — including a BLOCK-ONLY run that created a `[remotes.*]` block but had no value changes
to apply, where `counts.written` stays `0` even though `wrote` is `true` (the count is of VALUE
writes only); `wrote` is `false` for both `--dry-run` and a declined confirmation, block-only or
not, regardless of `destination.created`.

### `-o/--output` (legacy machine formats)

**Not supported.** `config pull` is a net-new TS command with no Go parity contract (CLI-2156,
mirrors `config diff`). Any `-o`/`--output` value — every machine-format value AND `pretty` — is
rejected outright (`LegacyConfigPullOutputFlagUnsupportedError`, exit 1), checked FIRST, before any
config load, target resolution, or network call:

```
the -o/--output flag is not supported by config pull; use --output-format json|stream-json instead.
```

## Notes

- Run from the project root (or pass `--workdir`); `config.toml`/`config.json` is read and written
  relative to it.
- **Scope resolution (ADR 0023) is pure and precedes any network call**: `--remote-label`, when
  passed, is resolved FIRST — even for a ref-shaped target — so its own remedy is never dead;
  failing that, an existing `[remotes.*]` block whose RAW `project_id` literal matches the resolved
  ref is always reused, regardless of how the target was named; failing that, a branch-named target
  creates a new `[remotes.<label>]`; otherwise the write lands at the config root. Either a
  `--remote-label` or a branch-derived label that names an EXISTING block tracking a DIFFERENT
  project is a collision, never a silent overwrite of that block's `project_id`. A block whose
  `project_id` is an `env(...)` reference that merely RESOLVES to the target ref is never reused or
  rewritten — hard error instead (see the exit-code table) — unless an explicit `--remote-label`
  already settled the destination some other way.
- **The write is never a full-document regeneration.** `packages/config/src/config-edit.ts`'s
  `applyConfigEdits` is a character-level scanner that splices only the spans that changed —
  comments, key ordering, and quoting elsewhere in the file are untouched — verified by re-parsing
  the edited text and deep-comparing it against an independently computed expectation before it is
  ever returned; a mismatch refuses the edit rather than writing anything.
- **Convergence**: a second `config pull` against an ALREADY-TRACKED target (root, or a
  `[remotes.*]` block that already exists and matches the target ref) with an unchanged remote
  plans zero writes and touches neither file (no `applyConfigEdits` call, no `git status` spawn, no
  prompt) — this is the design's own acceptance property (ADR 0023), not a special case. This
  no-work short-circuit is checked BEFORE the git dirty guard (not after, as it once was): a
  converged run never spawns `git` at all, so a config file with uncommitted changes never aborts
  (or warns about) a pull that would have written nothing either way.
- **A zero-drift branch/`--remote-label` target still creates its `[remotes.*]` block.** When the
  target is NOT already tracked by an existing block (a branch-named target, or `--remote-label`
  naming a new block) and its values happen to already match the local schema defaults, the run is
  NOT a no-op: it still has to write the new block's own `project_id`, or block reuse could never
  engage on a later run (the same ref would look untracked forever). This block-only write goes
  through the SAME git dirty guard and confirmation flow as any other write (`Create
[remotes.<label>] in <path>?` instead of the usual `Apply N change(s)...`, see Output) — only a
  run with NEITHER a value change NOR a new block skips straight to "no config differences found."
- **ADR-0021 "unpushable" families** (e.g. `auth.oauth_server`, disabled `storage.analytics`/
  `storage.vector`) ARE written by pull despite `config push` having no way to send them back — a
  `warnings[]` entry (`kind: "unpushable"`) says so instead of silently leaving a permanent gap.
- **Dual-scope root writes**: pulling a property the registry flags `dualScope` (e.g.
  `auth.site_url`, `db.settings.*`, `db.pooler.*`) into the config ROOT also changes what
  `supabase start` uses locally — flagged with a `dual_scope` warning, never refused.
- **The written file always reloads (ADR 0023 §d).** Pull never leaves `config.toml`/`.json` in a
  state a subsequent `loadCliConfig` call can't parse. Before writing, planned writes are expanded
  to a fixpoint (a value that GATES other declared fields — e.g. flipping a disabled SMS provider's
  `enabled` on — pulls its now-required siblings into the SAME write, not just the gate) and the
  projected result is decoded through the real config schema first; if it still wouldn't load, every
  write under the offending family/provider table is dropped (`skipped_reason: "would_invalidate"`,
  plus a `would_invalidate` warning naming the missing field(s) and, when applicable, the exact
  `env(VAR)` to set) rather than writing an unloadable file. A toggle whose required credentials
  pull cannot supply is therefore skipped, not written half-configured.
