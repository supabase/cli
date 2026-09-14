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
import { unsupportedOutputFlagMessage } from "../../../command-internal/go-output-flag.ts";
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
 * `config pull` writes a remote project or branch's configuration into `supabase/config.toml`/
 * `.json` (the config root, or an existing/new `[remotes.*]` block) after a confirmation prompt.
 * Its target resolution, fetch, and classify steps mirror `config diff`'s, up to the point where
 * the two commands diverge. The plan/apply run-core is hoisted to
 * `command-internal/config-pull-run.ts` so the `supabase pull` orchestrator can reuse it.
 */

export { openConfigPullSource };
export type { ConfigPullSource };

const mapBranchResolveError = mapHttpError({
  networkError: ConfigPullReadNetworkError,
  statusError: ConfigPullReadStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: unexpectedStatusMessage,
});

// Maps resolveConfigTarget's generic errors onto config pull's own tagged error classes.
const configTargetErrors = configTargetErrorsFor({
  notLinked: ConfigPullBranchNotLinkedError,
  parentRefInvalid: ConfigPullParentRefInvalidError,
  branchNotFound: ConfigPullBranchNotFoundError,
  branchNotReady: ConfigPullBranchNotReadyError,
});

/** Everything `config pull` does once the target is known, reusable independently of the CLI
 *  flag surface. */
export interface ConfigPullInput {
  readonly target: ConfigTarget;
  /** `--remote-label`, already filtered so an empty value reads as absent. */
  readonly remoteLabel: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
  /** `--yes` or `SUPABASE_YES` via `resolveYes`; unlike `config push`, this command never loads
   *  a project `.env` fallback. */
  readonly yes: boolean;
  /**
   * The base config load and its on-disk text, produced by {@link openConfigPullSource} before
   * target resolution so a malformed config doesn't burn a branch-resolution round trip; passed
   * through rather than reopened.
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

  // The text one-line disposition drops the caveats (opts.withCaveats: false) since the
  // change-by-change body above already rendered the same Note: lines; the machine-mode message
  // keeps them.
  const emitOutcome = (planForOutput: ConfigPullPlan, outcome: ConfigPullOutcome) =>
    output.format !== "text"
      ? output.success(
          configPullSummaryMessage(changeSet, scope, planForOutput, outcome),
          configPullPayload(changeSet, scope, planForOutput, context, outcome),
        )
      : output.raw(
          `${configPullSummaryMessage(changeSet, scope, planForOutput, outcome, { withCaveats: false })}\n`,
        );

  // --dry-run previews only: no git check, no prompt, no write. Checked before the hasWork
  // short-circuit below so a planner defect stays visible even on a run that would do nothing.
  if (input.dryRun) {
    if (output.format === "text") {
      yield* output.raw(renderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath));
    }
    yield* emitOutcome(finalPlan, { dryRun: true, declined: false });
    return;
  }

  // Nothing planned at all (no value write, no block to create) succeeds with no git check and
  // no prompt: a converged run never spawns `git status`, so an uncommitted-but-otherwise-clean
  // file never aborts a pull that wouldn't touch it.
  if (!runPlan.hasWork) {
    if (output.format === "text") {
      yield* output.raw(renderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath));
    }
    yield* emitOutcome(finalPlan, { dryRun: false, declined: false });
    return;
  }

  // Git dirty guard, reached only when there's work to do. --force skips it entirely; --yes
  // aborts rather than bypasses it, since no human is available to confirm once --yes answers
  // automatically.
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
  // Reuses the same plan.warnings hook the planner's path-scoped warnings render through
  // (renderConfigPullText's "Warnings:" section) — a repository-level warning, with no path.
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

  // A run with at least one value write keeps the "Apply N change(s)..." message, naming the
  // destination block when writing into one so the prompt is unambiguous about where. A
  // block-only run (no value writes, a zero-drift branch target) gets its own message naming
  // the block directly, since there's no per-change body to convey it.
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
    // Unreachable: writes.length === 0 only reaches this branch when hasWork was true, which
    // (after the short-circuit above) means createdTable must be set.
    return yield* Effect.die(
      new Error("config pull: nothing to confirm — hasWork invariant violated"),
    );
  }
  const confirmed = yield* promptYesNo(output, input.yes, confirmMessage, dirty ? false : true);
  if (!confirmed) {
    // A decline is a normal, expected outcome, not a failure: exit code stays 0 in every format,
    // mirroring config push's own treatment.
    yield* emitOutcome(planForRender, { dryRun: false, declined: true });
    return;
  }

  // Re-read against the baseline, apply, and write.
  yield* applyConfigPullRun({ runPlan, source: input.source });

  yield* emitOutcome(planForRender, { dryRun: false, declined: false });
});

/**
 * The command-facing entry point: rejects `-o/--output`, opens the base config source before
 * any network call or target resolution, resolves the target, then delegates to
 * {@link runConfigPull}.
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

  // Set once the target resolves, so the linked-project cache write below only fires for
  // invocations that got that far.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Reject -o/--output outright, before anything else: this command only supports
    // --output-format.
    if (Option.isSome(goOutputFlag)) {
      return yield* new ConfigPullOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("config pull"),
      });
    }

    // Validated before the base config source is opened so a missing workdir surfaces its own
    // error rather than the generic "no supabase/ project" one.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigPullWorkdirError({ message: error.message })),
    );

    // Opens the base config source (no [remotes.*] overlay, paired with its on-disk text)
    // before any network call or target resolution, so a missing file points at supabase init
    // and a malformed document doesn't burn a branch-resolution round trip.
    const source = yield* openConfigPullSource();

    // Resolves the pull target via resolveConfigTarget, shared with config diff/config push.
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
    // Telemetry flushes on every invocation; the linked-project cache write only fires once a
    // ref has resolved.
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
