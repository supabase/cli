# 0024. Top-Level `pull` Orchestration

**Status**: accepted
**Date**: 2026-09-08

## Problem Statement

CLI-1272 asks for a top-level `supabase pull` that refreshes local project state from a linked
Supabase project or branch in one step, covering two cases: bootstrapping a local checkout from an
existing remote project, and catching local files up after out-of-band dashboard/teammate changes.
By the time this command was designed, the CLI already had four independent pull-style commands —
`config pull`, `db pull`, `migration fetch`, and `functions download` — each owning its own target
resolution, its own confirmation (or none), and its own `output.success`/telemetry envelope. A user
who wants "catch me up" today has to know all four exist, run them individually, and reconcile
four separate outputs and (potentially) four separate `cli_command_executed` events by hand.

[ADR 0004](0004-cli-design-goals-and-workflows.md) already named this command in its outside-in
command surface table — `supabase push` / `supabase pull` — "Global sync — runs all sub-syncs in
**parallel**". Designing the real implementation surfaced two concrete data dependencies between
the sub-syncs that make that aspiration incorrect for `pull` specifically (see Decision 2 below);
this ADR records the refinement.

Three more constraints shaped the design, found only by reading the actual sub-step
implementations rather than assuming a thin composition layer would do:

1. `config pull`, `db pull`, and `migration fetch` each call `output.success` (or the text-mode
   equivalent) exactly once _inside their own handler_ — calling three of them unmodified from an
   orchestrator would emit three separate JSON objects on `--output-format json`, corrupting the
   "one JSON object per invocation" contract every other command upholds.
2. `db pull` reads `db.major_version` out of `config.toml` for shadow-container provisioning
   (`command-internal/db-pull-run.ts`, via `readDbToml`/`toml.majorVersion`) — a value
   `config pull` can have just changed moments earlier in the same `pull` invocation.
3. `db pull` reconciles `supabase/migrations` against the remote migration history table
   (`reconcileMigrations`, `command-internal/db-pull-run.ts`) and hard-fails
   (`DbPullMigrationConflictError`) when the remote has history the local directory doesn't —
   exactly the state a fresh checkout starts in, which is one of the two cases this command exists
   for.

## Decision

### 1. Resolve once; thread the ref, no target-resolution refactor

`resolveConfigTarget` (`command-internal/project-target.ts`) is called exactly once, in
`pull.handler.ts`, producing `{ ref, branch }`. That `ref` is passed directly into every sub-step's
existing `--project-ref`-shaped input (each step already accepts one) rather than reusing the
sub-step's own resolver end to end. This is safe because the resolved `ref` is always already the
API-addressable ref, including for a branch target: `resolveBranchProjectRef` returns
`detail.ref`/`branch.project_ref` and re-asserts it against the branch-project-ref pattern before
returning. Downstream, `ProjectRefResolver.loadProjectRef` short-circuits on a ref-shaped
value with no network call at all. The combination means passing `target.ref` through gives true
resolve-once behavior — one branch lookup, one config fetch — without touching any sub-step's own
resolver implementation.

### 2. Sequential execution, refining ADR 0004's "runs in parallel" aspiration for `pull`

Steps run in a fixed order: **config → migration history (conditional) → db → functions**. This
supersedes ADR 0004's "runs all sub-syncs in parallel" line for `pull` specifically, for three
reasons:

- **config → db.** The db step's shadow-container provisioning reads `db.major_version` from
  `config.toml`. If the config step just pulled a different major version, the db step must see the
  updated file, not a stale in-memory copy or a race against the write.
- **migration history → db.** The db step reconciles `supabase/migrations` against the remote
  history table and hard-fails when the remote has entries the local directory lacks. On a fresh
  checkout, that local directory is empty until the migration-history step populates it — so the db
  step must run after, not concurrently with or before, migration history.
- **Shared terminal rendering.** Text-mode progress (spinners, per-file "Schema written to ..."
  lines, Docker container log tee) is an unmultiplexed shared resource. Concurrent fibers writing to
  the same stdout/stderr streams would interleave into garbled output with no straightforward fix
  short of building a multiplexed renderer this command doesn't otherwise need.

Only the functions step has no data dependency on the other three; running it concurrently with the
others is a future option this design doesn't preclude, not something v1 does.

### 3. Emission ownership moves to the orchestrator

Each reused sub-step is split into a "run core" — a function that performs the real work and
returns a typed outcome, with no `output.success` call and no confirmation prompt of its own — and
its existing standalone-command emission stays only in that command's own top-level handler:

- `config pull`: `planConfigPullRun` (preview: fetch, diff, fixpoint-expand, validate — no
  git check, no prompt, no write) and `applyConfigPullRun` (the TOCTOU re-read, edit, atomic
  write). `runConfigPull` — the standalone command's own body — is reimplemented on top of
  these two with its exact existing behavior preserved; its own integration/e2e tests pass
  unmodified.
- `db pull`: `runDbPull(flags, invoke?)`, returning a typed `DbPullOutcome`. The
  standalone `dbPull` handler now calls this plus its own existing emission, unchanged
  externally. `DbPullInvoke` gained `assumeYes?: boolean` (the same precedent as its existing
  `skipFinishedLine`), which suppresses the internal "Update remote migration history table?"
  prompt for a caller whose own confirmation already covers it.
- `migration fetch`: `runMigrationFetch(input)`, taking an explicit `{ flags, target,
assumeYes? }` rather than deriving its target from raw CLI args (`resolveDbTargetFlags`),
  which an in-process caller has no argv to feed. `assumeYes` is required here, not cosmetic:
  `migrationConfirm` prompts regardless of `output.format` with a 10-minute stdin timeout —
  without an override, `pull --output-format json` on a TTY would hang waiting for input no
  machine-mode caller can answer.
- `functions download`: `downloadFunctions(flags, dependencies)` already returned a typed
  `DownloadFunctionsResult` rather than emitting; only its callers needed adjusting. `pull` wires
  `resolveProjectRef` to the already-resolved ref and `proxyDownload` to `Effect.die` (unreachable,
  since `legacyBundle` is always `false` for this caller).

`pull.handler.ts` itself calls only these run cores and owns the single `output.success`/telemetry
envelope. This is what keeps `pull --output-format json` down to exactly one JSON object no matter
how many of the four steps actually ran.

### 4. One confirmation, asymmetric preview

`pull` shows exactly one confirmation prompt (or, on `--dry-run`, one preview with no prompt),
covering all four steps. The preview is asymmetric because the sub-steps' own preview machinery
is asymmetric:

- **config** gets a real diff — `planConfigPullRun`'s plan is already fully computed by the
  time the confirmation renders, so `renderConfigPullText` renders the same change-by-change
  body `config diff`/`config pull --dry-run` would show.
- **db pull**, **migration fetch**, and **functions download** have no preview machinery of their
  own (no dry-run mode, no plan/apply split) — each gets one qualitative line in the confirmation
  body instead ("Pull the remote database schema into supabase/migrations...", "Download every Edge
  Function's source...", and a migration-history line only when that step will actually run this
  invocation).

The confirmed **bootstrap-auto-run** decision: migration history runs automatically whenever
`supabase/migrations` is missing or empty, even without `--with-migration-history` — there is
nothing local to overwrite, and this is what makes the fresh-checkout case actually work by default
instead of immediately hitting `db pull`'s own history-conflict hard failure (Problem Statement,
point 3). `--with-migration-history` remains for forcing a re-fetch over an already-populated
directory. One prompt honors `--dry-run` (preview only), `--yes` (skip the prompt, take the
default), and `--force` (bypass the config git-dirty guard) — the same flag vocabulary `config pull`
already established.

### 5. Partial-failure isolation

Steps run sequentially, but one step's failure does not stop the remaining steps from running and
being reported. Each step is wrapped with `Effect.exit`-based capture: a typed failure becomes
`{ kind: "failed", cause }` in the aggregate and the next step still runs; a defect or interruption
in that step's `Cause` (`Cause.hasDies`/`Cause.hasInterrupts`) is NOT captured — it propagates
immediately via `Effect.failCause`, since a defect means something is broken at a level below
"this step found a problem", and swallowing it as a per-step finding would hide a real bug. Once
every step has run, the aggregate is emitted (text mode) or attached to the machine error envelope
(`MachineErrorContext.set`), and only then is the FIRST original failure's `Cause` re-failed via
`Effect.failCause` — preserving that failure's own `_tag`/classification for telemetry, rather than
rebuilding a generic error that would lose it.

`db pull`'s "already in sync" condition (`DbPullInSyncError`) is caught at the `db` step's own
adapter (`pull.steps.ts`) and reported as `status: "unchanged"` — a finding, not a failure, at this
level, even though standalone `db pull` treats the same condition as a non-zero exit. This is a
deliberate, documented divergence (see the command's own `SIDE_EFFECTS.md`): from `pull`'s
perspective, "nothing to pull" is a completely ordinary outcome for one of four steps, not a reason
to fail the whole invocation.

### 6. Payload keyed by asset type

The `--output-format json`/`stream-json` payload is a top-level object with `steps` keyed by
`PullStepId` (`config`, `migration_history`, `db`, `functions`), plus `step_order` giving the
stable execution order as an array (so a consumer never has to hardcode or infer it), `target`,
`dry_run`, `confirmed`, `wrote`, and `counts` (per-status totals across the closed vocabulary
`changed | unchanged | skipped | planned | failed`, modelled on `ConfigPushServiceStatus`).
Keying by asset type rather than, say, an ordered array of step results makes a consumer's "did the
db step change anything" question a direct property lookup instead of a linear scan, and makes
adding a future step (e.g. storage buckets, see Non-Goals) an additive key rather than a shape
change to an existing array.

## Non-Goals (v1)

- **Storage bucket definitions.** The Management API's bucket-list endpoint
  (`v1ListAllBuckets`) returns only `{id, name, owner, created_at, updated_at, public}` — missing
  `file_size_limit`/`allowed_mime_types`/`objects_path`, which `storage.buckets` config needs
  (BRA-268, unstarted upstream). There is no faithful way to populate this from the API today.
  Adding a storage step later is additive to this design: one descriptor, one runner, one new
  `steps.storage` payload key — nothing about the resolve-once/sequential/emission-ownership
  decisions above needs to change.
- **`env pull`.** No `env` command family exists yet in this CLI; there is nothing for `pull` to
  orchestrate here until one is built.
- **`--declarative` passthrough for the db step.** `pull`'s own db-step invocation always runs in
  migration mode; a user who wants a declarative pull from a linked project still runs `db pull
--declarative` directly. Adding a passthrough flag is a small, independent follow-up, not part of
  this design.
- **Real db/functions dry-run previews.** Both steps get a qualitative confirmation line (Decision
  4), not a computed diff — neither has preview machinery of its own to build on, and building one
  is out of scope for this command.

## Consequences

### Positive

- One target resolution, one confirmation, one `cli_command_executed` event, and one JSON payload
  replace four separate command invocations for the "catch me up" workflow this command exists for.
- The bootstrap case (empty local checkout, existing remote project) now works by default: config,
  migration history, db, and functions all populate correctly on a fresh `supabase pull`, without
  the user needing to know to run `migration fetch` first to avoid `db pull`'s own history-conflict
  hard failure.
- Adding a fifth step later (storage, once BRA-268 ships) is additive — a new descriptor in
  `pull.steps.ts`, a new mapper in `pull.aggregate.ts`, a new payload key — not a redesign.
- Each sub-step's own standalone command and its own tests are untouched in behavior; the plan/apply
  split, run-core extraction, and `assumeYes` parameter are all additive to the existing surface.

### Negative

- `pull` is not purely a local-file refresh: the db step writes
  `supabase_migrations.schema_migrations` on the remote database whenever it finds migration-mode
  drift, and the db step requires Docker. A user who assumes "pull" means "read-only, local-only"
  is wrong, which is why this is called out explicitly in the confirmation message, this command's
  own `SIDE_EFFECTS.md`, and the user-facing docs page.
- Sequential execution means `pull`'s total wall-clock time is the sum of all four (or three, when
  migration history is skipped) steps' own times, not the maximum — a real cost for a command whose
  whole purpose is convenience. This is accepted as the price of correctness given the two real data
  dependencies in Decision 2; parallelizing the functions step specifically (the one step with no
  dependency on the others) remains a future option.
- The db step's own "already in sync" condition reads differently at this level (`unchanged`) than
  it does standalone (`db pull`'s own non-zero exit) — a script that greps `pull`'s own exit code
  the way it might grep standalone `db pull`'s will observe different behavior. This is documented
  as a deliberate divergence, not an oversight.

## Alternatives Considered

1. **Call each sub-step's existing standalone handler (`configPull`, `dbPull`,
   `migrationFetch`, `functionsDownload`) directly, unmodified**: rejected — each one
   calls `output.success` internally, so three would each independently emit a full JSON object,
   producing 3-4 JSON lines on stdout for one `pull` invocation and breaking the "one JSON object
   per command" contract every other command upholds under `--output-format json`.
2. **Keep ADR 0004's "runs in parallel" design**: rejected — `db pull` genuinely depends on
   `config pull`'s just-written `db.major_version` and on the migration-history step's own file
   writes; running them concurrently would either race on the config read or spuriously trip the
   remote-history-conflict hard failure on exactly the fresh-checkout case this command targets.
3. **Have each sub-step's own confirmation fire independently (four separate prompts)**: rejected —
   defeats the "one step" experience CLI-1272 asks for, and a machine-mode caller would have to
   suppress four separate prompts instead of one.
4. **Fail the whole command on the first step's failure (`Effect.all`-style short-circuiting)**:
   rejected — a user running `pull` to catch up several independent concerns (config, schema,
   functions) gains nothing from an early abort that hides whether the OTHER three steps would have
   succeeded; partial-failure isolation reports the full picture in one pass instead of requiring
   several retry-and-rerun cycles to discover each step's own state.

## Addendum (2026-09-08, post-review remediation)

A 4-agent review pass (architecture/engineering/security/DX) on the initial implementation found
several real defects, all fixed in the same change before merge — see the command's `SIDE_EFFECTS.md`
and git history for the full list (the `--dry-run` preview being silently dropped, the config step's
`written` field leaking an absolute path, the git-dirty guard aborting runs the config step had no
work in, an undisclosed migration-file-overwrite path, and a `pull.layers.ts` `Layer.mergeAll` merge
order the comment claimed decided the winning `ProjectRefResolver` but which Effect's actual
concurrent-build memoization made a race — fixed by eliminating the duplicate binding outright rather
than reordering). The same pass also added a `--remote-label` flag to `pull` itself, mirroring
`config pull`'s own flag of the same name — superseding the original "Non-Goals" section's
`--remote-label` bullet above, which this addendum removes since it no longer reflects what shipped.

Two follow-up decisions, made directly with the ticket owner rather than surfaced by an automated
review, extend section 4 and 5 above:

- **The git-dirty guard now covers `supabase/migrations` and `supabase/functions`, not just
  `supabase/config.toml`** — superseding section 4's "`--force` (bypass the config git-dirty guard)"
  line above, which described the guard's original, narrower scope. `supabase/migrations` is checked
  unconditionally (unless `--force`) rather than only when the migration-history step will run,
  because the `db` step has no preview machinery to know ahead of time whether it will find schema
  drift and write there; `supabase/functions` is checked unconditionally since the `functions` step
  always runs. `--force` now bypasses all three checks. See `pull.format.ts`'s
  `pullDirtyWarningMessage` and `pull.handler.ts`'s three independently-tracked dirty locations.
- **Failed steps now carry a "retry just this step" hint** naming the exact standalone command
  (`supabase <command> --project-ref <resolved-ref>`) — added because a failure inside an orchestrator
  is easy to mis-diagnose as "re-run the whole orchestrator" when re-running just the one failed
  sub-command is both correct and far cheaper. Appended to `failure.suggestion` after any
  step-specific remedy (e.g. the `db` step's migration-conflict hint), surfaced in both the JSON
  payload and the text-mode summary. See `pull.aggregate.ts`'s `pullRetryHint`.

## Related Decisions

- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals & Development Workflows —
  names `supabase pull` in the outside-in command surface and states the "runs all sub-syncs in
  parallel" aspiration this decision refines for `pull` specifically.
- [ADR 0023](0023-config-pull-write-strategy-and-scope-resolution.md): `config pull` Write Strategy
  and Scope Resolution — the plan/apply split this decision's `planConfigPullRun`/
  `applyConfigPullRun` extraction is built on top of, unchanged in its own write/scope rules.

## See Also

- [CLI-1272](https://linear.app/supabase/issue/CLI-1272) — this ticket
- `apps/cli/src/commands/pull/pull.handler.ts` — Phase 0-4 sequencing (target resolution, preview,
  confirmation, execution, aggregation)
- `apps/cli/src/commands/pull/pull.steps.ts` — the four step adapters over each sub-step's own run
  core
- `apps/cli/src/commands/pull/SIDE_EFFECTS.md` — the full side-effect inventory, including the
  database-write and Docker call-outs this ADR summarizes
