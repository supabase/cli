# 0023. `config pull` Write Strategy and Scope Resolution

**Status**: accepted
**Date**: 2026-09-02

## Problem Statement

`supabase config pull` (CLI-2064) takes the change set `config diff` (CLI-2156, ADR 0022) already knows how to compute and writes the `remote_only`/`update` entries back into `supabase/config.toml`/`.json`. Two problems are specific to writing, not comparing:

1. **How to write without destroying the file.** `config.toml` is user-authored: comments, key ordering, quoting style, and blank-line grouping all carry intent that CLI-2064's acceptance criteria require pull to preserve. The package's only existing persistence path, `saveCliConfig`, regenerates the whole document from a decoded `CliConfig` via `smol-toml`'s stringifier — correct for a full round trip, but it re-derives every line, so a file it touches loses its comments and ordering wholesale. Writing back a handful of changed values needs a different mechanism.
2. **Where to write.** A project can be linked directly (writing the config root makes sense) or resolved via a [persistent branch](0006-environment-management.md) that has its own `[remotes.<label>]` override block (ADR 0018). Writing branch-scoped values to the root would silently change what every OTHER branch — and the base local stack — resolves to; writing them to the wrong or a newly-invented block would never take effect, because the loader's own remote-selection rule (ADR 0018, `applyRemoteOverride`) might not select it back.

## Decision

### (a) Write strategy: surgical span-editing with mandatory re-parse verification

`packages/config/src/config-edit.ts` exports `applyConfigEdits(source, format, edits)`, a pure, synchronous, format-preserving editor scoped to `config pull`'s actual write surface: scalars, arrays of scalars, and creating new tables. It is a character-level scanner over the raw text — table headers, key-value lines, comments, blanks, basic/literal/multi-line strings, inline tables — that either splices an existing value's span in place or inserts a new line/table; it never deletes or reorders anything the caller didn't ask it to touch, so everything else survives byte-for-byte.

Every edited document goes through a mandatory verification gate before it is returned: the edited text is re-parsed with `smol-toml` and deep-compared, key for key, against `deepSet` of the *original* parse — an independently computed expected document, not a second walk of the same splice logic. A mismatch, from either a scanner misjudgment or a genuinely ambiguous document, is refused rather than shipped; the caller's file is never touched on a refusal. This is the load-bearing safety property: the editor is allowed to be conservative, but it is never allowed to be wrong.

The editor's refusal surface is an explicit, closed union rather than a best-effort patch-around: `duplicate_table_header`, `array_of_tables_on_path`, `inline_table_on_path`, `env_reference_target`, `verification_mismatch`, `parse_error`. `config pull`'s handler maps every refusal reason to its own typed error. A constrained editing surface that refuses instead of guessing on the constructs it doesn't model — `[[array.of.tables]]` on the target path, an inline table sitting on it, an existing `env(...)` literal at the destination — is recorded here as a deliberate feature, not a gap to close later.

JSON configs are handled differently: they are re-serialized rather than span-edited — parsed, mutated with the same `deepSet`, and `JSON.stringify`d back out with the file's detected indent and original key order (new keys appended) preserved, with the same re-parse verification gate. JSON has no comments and no meaningful quoting-style variance, so "preserve the file's own terms" holds in substance without needing span-level surgery. In both formats, a multi-line array's value is rewritten single-line when it is replaced — only the value span changes, never the surrounding key or comment text.

### (b) Scope resolution: narrowest scope, block reuse as the primary signal

`config pull` writes at the narrowest scope that affects only the resolved target, in this rule order:

1. **Reuse an existing `[remotes.*]` block** whose RAW, pre-`env()`-interpolation `project_id` literal matches the resolved ref, via `remoteNameForProjectRef` (`packages/config/src/io.ts`) — the exact rule the config loader's own overlay selection uses (ADR 0018's `applyRemoteOverride`). Block reuse, not whether the target was named as a branch, is the primary signal: however the user named the target (ref, branch UUID, branch name), if a block already claims that project, pull writes there. This makes pull and the loader's own remote selection exact inverses of each other — the block pull picks is provably the block that would apply on the next `supabase start`/`config push`.
2. **Else, if the target was named as a branch**, create `[remotes.<label>]`, labeled after the sanitized branch name (`--remote-label` overrides it). A label that collides with an existing block whose `project_id` names a *different* project is an error rather than a silent overwrite.
3. **Else** (a ref-shaped `--project-ref`, or the linked-project fallback with no branch involved) — the config root, with `dual_scope`-flagged properties (the registry's `dualScope` metadata) additionally surfaced as warnings, since some root-scoped settings (`auth.site_url`, `db.settings.*`, `db.pooler.*`, …) also govern the local stack and pulling a hosted value into them silently reconfigures `supabase start`.

A binding constraint governs rule 1's boundary: a `[remotes.*]` block whose `project_id` is an `env(...)` reference that *resolves* to the target ref is a hard error — never reused, never rewritten. The loader matches on the raw literal, never the resolved value (ADR 0018), so a value pull wrote into that block would never actually apply on the next load; pull would report success but never converge. Fixing this required exporting the single matching rule (`remoteNameForProjectRef`) from `@supabase/config` rather than reimplementing it, which also closed CLI-2287: `config diff`'s own precheck (`diff.handler.ts`) previously re-derived this match locally and diverged from the loader's raw-literal rule; it is now repointed onto the same exported function pull uses, so the two commands can never disagree about which block a ref matches.

The raw/interpolated distinction is the crux of both rule 1 and the hard error: `rawDocument` (pre-`env()`-interpolation, pre-remote-merge) decides WHERE pull writes; the interpolated document decides WHAT value it prints and compares. Confusing the two — matching a block against a resolved value, or writing into one selected by resolved comparison — reintroduces exactly the non-convergence CLI-2287 fixed.

## Rationale

- **Regeneration was never viable for pull specifically.** `saveCliConfig`'s full-document `smol-toml` stringify is correct for `supabase init`'s scaffold and any caller that owns the whole document, but CLI-2064's acceptance criteria are explicit that a user's comments, ordering, and quoting survive a pull unrelated to them. A regenerate-and-diff-the-bytes approach cannot satisfy that; only touching exactly the spans that changed can.
- **No maintained format-preserving TOML AST library exists** to adopt in its place, and pulling one in would make it the package's second TOML dependency alongside `smol-toml` for a comparatively narrow write surface. Writing the surgical editor directly keeps `smol-toml` as the only TOML dependency and keeps the write surface exactly as large as `config pull` actually needs — scalars, arrays of scalars, and table creation — rather than a general-purpose editor's larger, harder-to-verify surface.
- **Verification against an independently computed expectation, not against the splice logic's own output**, is what makes refusal trustworthy: `deepSet` over the original parse is a different code path from the scanner/placement logic, so a bug in one is unlikely to also fool the other into agreeing on a wrong result.
- **Block reuse over branch-ness** as the primary scope signal is what keeps pull and the loader in lockstep: a user can rename a `[remotes.*]` block's label freely, or reach the same project via a bare `--project-ref`, and pull must still find the block that actually governs that project rather than creating a second one.

## Consequences

### Positive

- Pull never removes a property from the file: every edit is a replace-in-place or an insert, so a user's local-only, unmanaged, masked, or `env()`-valued properties are never candidates for a write in the first place (ADR 0022's classification already keeps them out of `changes`), and nothing pull *does* write can delete something else nearby.
- Pull and the config loader can never disagree about which `[remotes.*]` block a target ref selects — the CLI-2287 fix is structural (one exported function, two call sites), not a pair of implementations kept in sync by convention.
- The convergence invariant — a second pull run against an unchanged remote writes nothing, and the file is byte-identical to before — falls out of the design rather than needing a special case: no `changes` entries means no edits, means `applyConfigEdits` is never called. This invariant is the acceptance test of the whole design; a residual, non-empty change set after a pull that just wrote it is a planner defect, not user-visible drift.

### Negative

- ADR-0021's unpushable families (`auth.oauth_server`, disabled `storage.analytics`/`storage.vector`, and the other document-arm-only omissions) ARE written by pull despite `config push` having no way to send them back — the alternative, skipping them, leaves a permanent, unexplained gap between what the platform reports and what the file says with no route to close it. Pull instead writes them and surfaces a note that `config push` cannot send these properties back, trading a one-directional property for an explained one.
- The editor's refusal surface means a subset of otherwise-legitimate documents (an array-of-tables or inline table sitting on a write path, an `env(...)` literal already at the destination) cannot be pulled into automatically; the user must resolve the shape by hand first. This is accepted as the cost of never silently mis-editing those constructs.
- Rule 3's dual-scope warnings are advisory, not a hard stop: pulling a hosted `auth.site_url` into the root when the user runs `supabase start` locally against the same file is a real, if opt-in, behavior change to the local stack. Pull does not refuse this; it only names the properties involved.

## Alternatives Considered

1. **Full-file regeneration via `saveCliConfig`/`smol-toml` stringify**: rejected — destroys comments, key ordering, and quoting style on every write, which directly violates CLI-2064's acceptance criteria.
2. **Adopt a format-preserving TOML AST dependency**: rejected — no maintained candidate exists, and it would become the package's second TOML dependency for a write surface this narrow; the hand-written scanner stays small precisely because it only needs to model scalars, arrays of scalars, and table creation, and refuses everything else.
3. **Match `[remotes.*]` blocks against the resolved `project_id`** (post-`env()`-interpolation) instead of the raw literal: looks more permissive, but reuses or creates a block the loader's own overlay would never select, which never converges — this is precisely the bug CLI-2287 named and this ADR's binding constraint forbids.
4. **Always write branch-named targets to a newly labeled block, ignoring any existing block that already claims the project**: rejected — would fragment a project's overrides across two blocks (the pre-existing one still selected by the loader, and a new one pull just wrote that never applies), which is worse than the label-collision error rule 2 chooses instead.

## Related Decisions

- [ADR 0018](0018-sparse-config-subtraction.md): Sparse Config Subtraction — the base-vs-remote-block merge semantics and raw-literal `project_id` matching rule this decision's scope resolution reuses via `remoteNameForProjectRef`.
- [ADR 0021](0021-projectconfig-convergence-semantics.md): `ProjectConfig` Convergence Semantics — the unpushable-family omissions this decision's write-them-anyway rule carves an exception into for pull specifically.
- [ADR 0022](0022-config-diff-classification-and-managed-surface.md): Config Diff Classification and Managed Surface — the change-set classifier (`update`/`remote_only`/`local_only`, masked/unmanaged surfacing) `config pull` consumes as its planning input.

## See Also

- [CLI-2064](https://linear.app/supabase/issue/CLI-2064/add-supabase-config-pull-to-the-cli) — this ticket
- [CLI-2287](https://linear.app/supabase/issue/CLI-2287) — the `config diff` precheck drift this decision's exported raw-literal matching rule fixes
- `packages/config/src/config-edit.ts` — the surgical editor's own header comment records the same design rules in implementation terms
- `packages/config/src/io.ts` — `remoteNameForProjectRef`/`remoteProjectIdEntries` (the shared raw-literal match) and `writeCliConfigDocumentText` (the atomic temp-file-plus-rename write, typed `CliConfigWriteError` on failure)
