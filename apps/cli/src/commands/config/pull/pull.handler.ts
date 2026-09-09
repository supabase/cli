import { Effect, FileSystem, Option } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { pathHasUncommittedChanges } from "../../../command-internal/git-status.ts";
import {
  mapHttpError,
  sanitizeInlineName,
  unexpectedStatusMessage,
} from "../../../command-internal/http-errors.ts";
import {
  configTargetErrorsFor,
  resolveConfigTarget,
  type ConfigTarget,
} from "../../../command-internal/project-target.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYes, OutputFlag } from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import {
  applyConfigPullRun,
  configPullPayload,
  openConfigPullSource,
  planConfigPullRun,
  renderConfigPullText,
  type ConfigPullOutcome,
  type ConfigPullSource,
} from "../../../command-internal/config-pull-run.ts";
import { configPullCreatedBlockLabel, configPullSummaryMessage } from "./pull.format.ts";
import type { ConfigPullPlan } from "./pull.plan.ts";
import {
  ConfigPullBranchNotFoundError,
  ConfigPullBranchNotLinkedError,
  ConfigPullBranchNotReadyError,
  ConfigPullOutputFlagUnsupportedError,
  ConfigPullParentRefInvalidError,
  ConfigPullReadNetworkError,
  ConfigPullReadStatusError,
  ConfigPullUncommittedChangesError,
  ConfigPullWorkdirError,
} from "./pull.errors.ts";
import type { ConfigPullFlags } from "./pull.command.ts";

/**
 * `config pull` — writes a remote project or branch's configuration into
 * `supabase/config.toml`/`.json` (root, or an existing/new `[remotes.*]`
 * block), after a confirmation prompt. Mirrors `config diff`'s target
 * resolution, fetch, and classify steps (`../diff/diff.handler.ts`)
 * step-for-step through the point where the two commands diverge (CLI-2064).
 *
 * The plan/apply run-core (opening the base config source, planning,
 * applying, and the render/payload builders) is hoisted to
 * `command-internal/config-pull-run.ts` (CLI-1272) so the `supabase pull`
 * orchestrator (`commands/pull/`) can reuse it without importing this
 * command family's own files. `configPull` (steps 1-4) rejects
 * `-o/--output`, then opens the base config source via
 * `openConfigPullSource` — a load with NO `[remotes.*]` overlay,
 * paired with that SAME load's own captured on-disk text (`LoadedCliConfig.rawText`)
 * — BEFORE any network call or target resolution, then resolves the target
 * and delegates to `runConfigPull` (steps 5-15) — the reusable,
 * target-agnostic body kept here since it is not itself reused by another
 * command family; `supabase pull` composes the SAME plan/apply/render pieces
 * into its own multi-step confirmation instead of calling `runConfigPull`
 * directly. The plan's own `ConfigPullInput` sketch omits
 * the loaded config/file text; this implementation carries them through
 * explicitly (as a single `ConfigPullSource`) instead of
 * reloading/re-reading inside `runConfigPull`, since `configPull`
 * already holds both by the time it delegates. Pairing them behind one
 * exported constructor — rather than two independently-assembled fields on
 * `ConfigPullInput` — is what makes "loaded without overlay, text taken
 * from that SAME load" true BY CONSTRUCTION rather than by caller convention
 * (see `ConfigPullSource`'s own doc comment, `command-internal/config-pull-run.ts`).
 */

export { openConfigPullSource };
export type { ConfigPullSource };

const mapBranchResolveError = mapHttpError({
  networkError: ConfigPullReadNetworkError,
  statusError: ConfigPullReadStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: unexpectedStatusMessage,
});

/** Error construction for `resolveConfigTarget` (`command-internal/project-target.ts`), keeping
 *  `config pull`'s own tagged error classes; the message wording is shared there. */
const configTargetErrors = configTargetErrorsFor({
  notLinked: ConfigPullBranchNotLinkedError,
  parentRefInvalid: ConfigPullParentRefInvalidError,
  branchNotFound: ConfigPullBranchNotFoundError,
  branchNotReady: ConfigPullBranchNotReadyError,
});

/**
 * Steps 5-15 of `config pull`, reusable independently of the CLI flag
 * surface (plan §1.6's library seam) — everything AFTER the target is known.
 */
export interface ConfigPullInput {
  readonly target: ConfigTarget;
  /** `--remote-label`, already filtered so an empty value reads as absent. */
  readonly remoteLabel: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
  /** `--yes` OR `SUPABASE_YES` (the GLOBAL flag — `resolveYes`, no
   * project-`.env` fallback: unlike `config push`, this command never loads
   * one). */
  readonly yes: boolean;
  /**
   * The base config load + its on-disk text (`configPull` steps 2-3),
   * produced by {@link openConfigPullSource} BEFORE target resolution
   * (a malformed config must not burn a branch-resolution round trip) — so
   * `configPull` already holds it by the time it delegates here,
   * passed through rather than reopened.
   */
  readonly source: ConfigPullSource;
}

export const runConfigPull = Effect.fnUntraced(function* (input: ConfigPullInput) {
  const output = yield* Output;

  const runPlan = yield* planConfigPullRun({
    target: input.target,
    remoteLabel: input.remoteLabel,
    source: input.source,
  });
  const { changeSet, scope, plan: finalPlan, context, configFilePath } = runPlan;
  const ref = context.projectRef;

  // The TEXT one-line disposition drops the caveats (`opts.withCaveats:
  // false`, item F.2 of CLI-2064's fix pass) — the change-by-change body
  // above already rendered the same `Note:` lines once; the machine-mode
  // `message` keeps them, since it is the only place an agent reads them.
  const emitOutcome = (planForOutput: ConfigPullPlan, outcome: ConfigPullOutcome) =>
    output.format !== "text"
      ? output.success(
          configPullSummaryMessage(changeSet, scope, planForOutput, outcome),
          configPullPayload(changeSet, scope, planForOutput, context, outcome),
        )
      : output.raw(
          `${configPullSummaryMessage(changeSet, scope, planForOutput, outcome, { withCaveats: false })}\n`,
        );

  // 9. `--dry-run`: preview only. Never runs the git check, never prompts,
  // never touches the file. Comes before the `hasWork` short-circuit below —
  // a planner defect must be visible even on a run that would do nothing.
  if (input.dryRun) {
    if (output.format === "text") {
      yield* output.raw(renderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath));
    }
    yield* emitOutcome(finalPlan, { dryRun: true, declined: false });
    return;
  }

  // 9.5. Nothing planned AT ALL — no value write, no `[remotes.*]` block to
  // create — success, no git check, no prompt. Doing this check BEFORE the
  // git guard (rather than after, as it used to run) is what fixes bug A: a
  // converged run never spawns `git status` at all, so an
  // uncommitted-but-otherwise-clean config file never aborts a pull that was
  // never going to touch it.
  if (!runPlan.hasWork) {
    if (output.format === "text") {
      yield* output.raw(renderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath));
    }
    yield* emitOutcome(finalPlan, { dryRun: false, declined: false });
    return;
  }

  // 10. Git dirty guard (plan §1.4), reached only when there's work to do.
  // `--force` skips it entirely — no check, no warning, no prompt-default
  // flip. `--yes` aborts rather than bypasses (CLI-2064 item C): no human is
  // on hand to read the warning and answer the prompt honestly once `--yes`
  // answers it automatically, on any TTY.
  let dirty = false;
  if (!input.force) {
    const dirtyOption = yield* pathHasUncommittedChanges(configFilePath);
    dirty = Option.getOrElse(dirtyOption, () => false);
    if (dirty) {
      const tty = yield* Tty;
      if (input.yes || output.format !== "text" || !tty.stdinIsTty) {
        return yield* new ConfigPullUncommittedChangesError({
          message: `${context.configPath} has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force to write anyway.`,
        });
      }
    }
  }
  // Reuses the SAME `plan.warnings` hook the planner's own path-scoped
  // warnings render through (`renderConfigPullText`'s "Warnings:"
  // section) — a repository-level warning, no `path`.
  const planForRender: ConfigPullPlan = dirty
    ? {
        ...finalPlan,
        warnings: [...finalPlan.warnings, { kind: "uncommitted_changes" }],
      }
    : finalPlan;

  if (output.format === "text") {
    yield* output.raw(
      renderConfigPullText(changeSet, scope, planForRender, ref, context.configPath),
    );
  }

  // 11. Confirm. A run with at least one value write keeps the established
  // "Apply N change(s)..." message even when it ALSO creates a block (the
  // rendered body above already called that out) — naming the destination
  // block too, when writing into one, so the prompt itself is unambiguous
  // about WHERE (omitted for the config root); a block-ONLY run (no value
  // writes — bug B's zero-drift branch target) gets its own message naming
  // the block directly, since there is no per-change body to convey it
  // otherwise.
  let confirmMessage: string;
  if (planForRender.writes.length > 0) {
    const destinationSuffix =
      context.destination.kind === "remote"
        ? ` [remotes.${sanitizeInlineName(context.destination.label)}]`
        : "";
    confirmMessage = `Apply ${planForRender.writes.length} change(s) to ${context.configPath}${destinationSuffix}?`;
  } else if (planForRender.createdTable !== undefined) {
    confirmMessage = `Create [remotes.${configPullCreatedBlockLabel(planForRender.createdTable)}] in ${context.configPath}?`;
  } else {
    // Unreachable: `writes.length === 0` only reaches this branch when
    // `hasWork` was true, which (post the step-9.5 short-circuit above) means
    // `createdTable` must be set.
    return yield* Effect.die(
      new Error("config pull: nothing to confirm — hasWork invariant violated"),
    );
  }
  const confirmed = yield* promptYesNo(output, input.yes, confirmMessage, dirty ? false : true);
  if (!confirmed) {
    // Mirrors `config push`'s own treatment of a declined confirmation (each
    // service is marked "skipped" and the command still succeeds) — a
    // decline is a normal, expected outcome, not a failure: exit code stays
    // 0 in every format.
    yield* emitOutcome(planForRender, { dryRun: false, declined: true });
    return;
  }

  // 12-13. Re-read against the step-3 baseline, apply, and write.
  yield* applyConfigPullRun({ runPlan, source: input.source });

  // 14. Final summary/payload.
  yield* emitOutcome(planForRender, { dryRun: false, declined: false });
});

/**
 * `configPull` — the command-facing entry point (steps 1-4): rejects
 * `-o/--output`, opens the base config source (`openConfigPullSource`)
 * BEFORE any network call or target resolution, resolves the target, then
 * delegates to {@link runConfigPull} for the rest.
 */
export const configPull = Effect.fn("config.pull")(function* (flags: ConfigPullFlags) {
  const goOutputFlag = yield* OutputFlag;
  const yes = yield* resolveYes;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // An empty `--project-ref`/`--remote-label` value is absent, mirroring the
  // target resolver's own rule.
  const requested = Option.filter(flags.projectRef, (value) => value.length > 0);
  const remoteLabel = Option.getOrUndefined(
    Option.filter(flags.remoteLabel, (value) => value.length > 0),
  );

  // Written once the target is known, so the linked-project cache finalizer
  // below only fires for invocations that got that far (mirrors `config
  // diff`).
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // 1. Reject the Go-compat `-o/--output` flag outright, before anything
    // else — `config pull` is a net-new TS command with no Go parity
    // contract (CLI-2156, mirrors `config diff`).
    if (Option.isSome(goOutputFlag)) {
      return yield* new ConfigPullOutputFlagUnsupportedError({
        message:
          "the -o/--output flag is not supported by config pull; use --output-format json|stream-json instead.",
      });
    }

    // 1.5. The resolved `--workdir`/`SUPABASE_WORKDIR` must exist and be a
    // directory before the base config source is opened — distinguishes
    // "the directory doesn't exist" from "it exists but holds no
    // `supabase/` project" (the step 2-3 load below).
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigPullWorkdirError({ message: error.message })),
    );

    // 2-3. Open the base config source (load with NO `[remotes.*]` overlay,
    // paired with its on-disk text) BEFORE any network call or target
    // resolution — a missing file must point at `supabase init` rather than
    // the resolver's not-linked error, and a malformed document must not
    // burn a branch-resolution round trip.
    const source = yield* openConfigPullSource();

    // 4. Resolve the pull target — hoisted into `resolveConfigTarget`
    // (`command-internal/project-target.ts`, shared with `config diff`/`config push`, CLI-2064).
    const { ref, branch } = yield* resolveConfigTarget(
      requested,
      configTargetErrors,
      mapBranchResolveError,
    );
    resolvedRef = ref;

    yield* runConfigPull({
      target: { ref, branch },
      remoteLabel,
      dryRun: flags.dryRun,
      force: flags.force,
      yes,
      source,
    });
  }).pipe(
    // CLI Invariant #1: telemetry flushes on EVERY invocation —
    // including load/parse failures and branch-resolution failures — while
    // the linked-project cache write needs a resolved ref, so it fires
    // exactly when one exists (mirrors `config diff`).
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
