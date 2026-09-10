import { Cause, Effect, Exit, FileSystem, Option, Path, Predicate } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { pathHasUncommittedChanges } from "../../command-internal/git-status.ts";
import { mapHttpError } from "../../command-internal/http-errors.ts";
import { MigrationsReadError } from "../../command-internal/migration.errors.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/go-output-flag.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import { MachineErrorContext } from "../../shared/output/machine-error-context.service.ts";
import { resolveYes, OutputFlag } from "../../command-internal/global-flags.ts";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  configTargetErrorsFor,
  resolveConfigTarget,
} from "../../command-internal/project-target.ts";
import { unexpectedStatusMessage } from "../../command-internal/http-errors.ts";
import {
  configPullPayload,
  openConfigPullSource,
  planConfigPullRun,
  renderConfigPullText,
  type ConfigPullOutcome,
  type ConfigPullRunPlan,
} from "../../command-internal/config-pull-run.ts";
import { DbPullMigrationConflictError } from "../../command-internal/db-pull-run.errors.ts";
import {
  pullConfigStep,
  pullDbStep,
  pullFunctionsStep,
  pullMigrationHistoryStep,
} from "./pull.steps.ts";
import {
  pullAggregate,
  pullConfigStepResult,
  pullDbStepResult,
  pullFailedStepResult,
  pullFunctionsStepResult,
  pullMigrationHistoryStepResult,
  pullRetryHint,
  pullWithMigrationHistoryCommand,
  type PullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import {
  pullConfirmMessage,
  pullDirtyWarningMessage,
  pullPayload,
  pullSummaryMessage,
  renderPullSummary,
} from "./pull.format.ts";
import type { PullAggregate, PullStepContext, PullStepResult } from "./pull.types.ts";
import {
  PullBranchNotFoundError,
  PullBranchNotLinkedError,
  PullBranchNotReadyError,
  PullBranchResolveNetworkError,
  PullBranchResolveStatusError,
  PullOutputFlagUnsupportedError,
  PullParentRefInvalidError,
  PullUncommittedChangesError,
  PullWorkdirError,
} from "./pull.errors.ts";
import type { PullFlags } from "./pull.command.ts";

/** Wires `pull`'s own tagged error classes into `resolveConfigTarget`. */
const pullTargetErrors = configTargetErrorsFor({
  notLinked: PullBranchNotLinkedError,
  parentRefInvalid: PullParentRefInvalidError,
  branchNotFound: PullBranchNotFoundError,
  branchNotReady: PullBranchNotReadyError,
});

const mapBranchResolveError = mapHttpError({
  networkError: PullBranchResolveNetworkError,
  statusError: PullBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: unexpectedStatusMessage,
});

/** The union of every typed error the four step runners (`pull.steps.ts`) can fail with — keeps
 *  `firstFailureCause` typed instead of erasing the error channel to `unknown`. */
type PullStepFailureCause =
  | Effect.Error<ReturnType<typeof pullConfigStep>>
  | Effect.Error<ReturnType<typeof pullMigrationHistoryStep>>
  | Effect.Error<ReturnType<typeof pullDbStep>>
  | Effect.Error<ReturnType<typeof pullFunctionsStep>>;

/** The config step's own machine payload, verbatim — `runPlan`'s fields plus the run's actual
 *  `{dryRun, declined}` disposition. One call site so every place that builds a config
 *  `PullStepResult` shapes the payload identically. */
const configPullPayloadFor = (runPlan: ConfigPullRunPlan, outcome: ConfigPullOutcome) =>
  configPullPayload(runPlan.changeSet, runPlan.scope, runPlan.plan, runPlan.context, outcome);

/**
 * Emits the aggregate for every non-failure disposition (dry run, declined, or fully
 * succeeded). The mixed-failure disposition is inlined separately instead, since machine mode
 * there feeds the payload into `MachineErrorContext` ahead of a re-failed cause.
 */
const pullEmit = (output: typeof Output.Service, aggregate: PullAggregate) =>
  output.format === "text"
    ? output.raw(renderPullSummary(aggregate))
    : output.success(pullSummaryMessage(aggregate), pullPayload(aggregate));

/**
 * Runs `effect`, capturing a typed failure into `{kind: "failed", cause}` instead of letting it
 * propagate; a defect or interruption still propagates immediately via `Effect.failCause`. Lets
 * every step run even when an earlier one failed, preserving the first failure to re-fail with.
 */
function pullCaptureStep<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "failed"; readonly cause: Cause.Cause<E> },
  E,
  R
> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) {
      return { kind: "ok", value: exit.value } as const;
    }
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) {
      return yield* Effect.failCause(exit.cause);
    }
    return { kind: "failed", cause: exit.cause } as const;
  });
}

/**
 * Appends `extra` to `result`'s own `failure.suggestion` on its own line, never replacing
 * what's already there. A no-op for a non-failed result, so multiple suggestion sources can
 * compose without clobbering each other.
 */
function pullAppendSuggestion(result: PullStepResult, extra: string): PullStepResult {
  if (result.failure === undefined) {
    return result;
  }
  return {
    ...result,
    failure: {
      ...result.failure,
      suggestion:
        result.failure.suggestion === undefined ? extra : `${result.failure.suggestion}\n${extra}`,
    },
  };
}

/**
 * The db step's failure result, with one addition: when the cause is
 * `DbPullMigrationConflictError`, appends a suggestion to rerun with `--with-migration-history`,
 * naming the exact `ref`/`remoteLabel` this run resolved. A bare rerun could otherwise silently
 * retarget the checkout's linked project instead, which matters since the command writes to the
 * remote migration history table.
 */
function pullDbStepFailureResult(
  cause: unknown,
  ref: string,
  remoteLabel: string | undefined,
  workdir: string,
): PullStepResult {
  const result = pullFailedStepResult("db", cause, workdir);
  if (!(cause instanceof DbPullMigrationConflictError)) {
    return result;
  }
  return pullAppendSuggestion(
    result,
    `Alternatively, rerun \`${pullWithMigrationHistoryCommand(ref, remoteLabel)}\` to fetch and reconcile the remote migration history table automatically.`,
  );
}

/**
 * Appends the standalone command to retry just this failed step on top of whatever the step's
 * own failure already says — including, for the db step, the `--with-migration-history` remedy
 * `pullDbStepFailureResult` may have already appended. A no-op for a non-failed result.
 */
function pullWithRetryHint(
  result: PullStepResult,
  ref: string,
  remoteLabel: string | undefined,
): PullStepResult {
  return pullAppendSuggestion(result, pullRetryHint(result.step, ref, remoteLabel));
}

/**
 * `supabase pull` orchestrates `config pull`, an optional `migration fetch`, `db pull`, and
 * `functions download` behind one target resolution, one confirmation, and one aggregated
 * result (see ADR 0024). The `db` step also writes to the remote database's migration history
 * table and requires Docker.
 */
export const pull = Effect.fn("pull")(function* (flags: PullFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const yes = yield* resolveYes;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const machineErrorContext = yield* MachineErrorContext;

  const requested = Option.filter(flags.projectRef, (value) => value.length > 0);
  const remoteLabel = Option.getOrUndefined(
    Option.filter(flags.remoteLabel, (value) => value.length > 0),
  );

  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Rejects `-o`/`--output` outright; `pull` only supports `--output-format`.
    if (Option.isSome(goOutputFlag)) {
      return yield* new PullOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("pull"),
      });
    }

    // Must exist and be a directory before anything else — beats every step's own target
    // resolution and network calls.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new PullWorkdirError({ message: error.message })),
    );

    // Resolves the pull target exactly once; every sub-step below targets `ref` directly
    // instead of re-resolving (ADR 0024).
    const source = yield* openConfigPullSource();
    const { ref, branch } = yield* resolveConfigTarget(
      requested,
      pullTargetErrors,
      mapBranchResolveError,
    );
    resolvedRef = ref;

    // `planConfigPullRun` does everything up through the schema-validation gate: no git check,
    // no prompt, no write.
    const runPlan = yield* planConfigPullRun({
      target: { ref, branch },
      remoteLabel,
      source,
    });

    // Retry hints below use the planned remote destination's label, not the raw `remoteLabel`
    // flag: for a branch-derived implicit target, that's the `[remotes.<branch>]` block the
    // plan actually targets, which may differ from an unset `--remote-label`.
    const plannedRemoteLabel =
      runPlan.context.destination.kind === "remote" ? runPlan.context.destination.label : undefined;

    // Only checks git status when the config step actually has work to write, so an
    // uncommitted-but-otherwise-clean config file never aborts a pull that wasn't going to
    // touch it.
    const configDirty =
      flags.force || !runPlan.hasWork
        ? false
        : Option.getOrElse(yield* pathHasUncommittedChanges(runPlan.configFilePath), () => false);

    // The db step always runs and has no preview machinery (ADR 0024), so migrations are
    // checked unconditionally for uncommitted changes — not just when migration-history also
    // runs — skipped only by `--force`.
    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
    const migrationsDirty = flags.force
      ? false
      : Option.getOrElse(yield* pathHasUncommittedChanges(migrationsDir), () => false);

    // Functions always runs too, with no way to know if there's work without calling the API
    // first — checked unconditionally like migrations.
    const functionsDir = path.join(cliSettings.workdir, "supabase", "functions");
    const functionsDirty = flags.force
      ? false
      : Option.getOrElse(yield* pathHasUncommittedChanges(functionsDir), () => false);

    // Tracked separately (not collapsed into one boolean) so the confirmation body and the
    // abort error can each name exactly which path(s) are dirty.
    const dirtyPaths: ReadonlyArray<string> = [
      ...(configDirty ? [runPlan.context.configPath] : []),
      ...(migrationsDirty ? ["supabase/migrations"] : []),
      ...(functionsDirty ? ["supabase/functions"] : []),
    ];
    const dirty = dirtyPaths.length > 0;

    // Auto-runs whenever `supabase/migrations` is missing or empty, even without
    // `--with-migration-history` (ADR 0024's bootstrap decision): a fresh checkout has nothing
    // to overwrite. Uses the same raw, unfiltered directory listing `migration fetch`'s own
    // overwrite-confirmation guard uses, so a directory holding only a README/.gitkeep reads as
    // non-empty in both places.
    const shouldFetchMigrationHistory = flags.withMigrationHistory
      ? true
      : (yield* fs.readDirectory(migrationsDir).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Predicate.isTagged(cause.reason, "NotFound")
              ? Effect.succeed<ReadonlyArray<string>>([])
              : Effect.fail(
                  new MigrationsReadError({
                    message: `failed to read migrations: ${cause.message}`,
                  }),
                ),
          ),
        )).length === 0;
    const migrationHistoryReason: "flag" | "bootstrap" | undefined = !shouldFetchMigrationHistory
      ? undefined
      : flags.withMigrationHistory
        ? "flag"
        : "bootstrap";

    // One confirmation with an asymmetric preview: a real diff for config, a qualitative
    // description for db/functions/migration-history.
    //
    // Rendered whenever the changeset has any change at all, not just when `runPlan.hasWork`
    // (which can be `false` even with real changes, when every one was skipped as an
    // env-reference, an unpushable family, etc.) — otherwise a real (if unwritable) diff would
    // silently read as "No config differences found."
    const configDiffText =
      runPlan.changeSet.changes.length > 0
        ? renderConfigPullText(
            runPlan.changeSet,
            runPlan.scope,
            runPlan.plan,
            ref,
            runPlan.context.configPath,
          )
        : undefined;
    const confirmBody = pullConfirmMessage({
      ref,
      branch,
      configDiffText,
      willFetchMigrationHistory: shouldFetchMigrationHistory,
      migrationHistoryReason,
      dirtyPaths,
    });

    // Printed ahead of both the dry-run early return and the real confirmation prompt, so a
    // dry run sees the same disclosure body a real run would, not just the status summary.
    if (output.format === "text") {
      yield* output.raw(confirmBody);
    }

    if (flags.dryRun) {
      const results: ReadonlyArray<PullStepResult> = [
        pullConfigStepResult(
          {
            dryRun: true,
            hasWork: runPlan.hasWork,
            confirmed: false,
            configFilePath: runPlan.context.configPath,
          },
          configPullPayloadFor(runPlan, { dryRun: true, declined: false }),
        ),
        pullMigrationHistoryStepResult(
          shouldFetchMigrationHistory
            ? { kind: "planned" }
            : { kind: "skipped", reason: "not_needed" },
        ),
        pullDbStepResult({ kind: "planned" }),
        pullFunctionsStepResult({ kind: "planned" }),
      ];
      const aggregate = pullAggregate({
        ref,
        branch,
        dryRun: true,
        confirmed: false,
        dirtyPaths,
        results,
      });
      yield* pullEmit(output, aggregate);
      return;
    }

    if (dirty) {
      const tty = yield* Tty;
      if (yes || output.format !== "text" || !tty.stdinIsTty) {
        return yield* new PullUncommittedChangesError({
          message: pullDirtyWarningMessage(dirtyPaths),
        });
      }
    }

    const confirmed = yield* promptYesNo(output, yes, "Proceed with pull?", dirty ? false : true);
    if (!confirmed) {
      const results: ReadonlyArray<PullStepResult> = [
        pullConfigStepResult(
          {
            dryRun: false,
            hasWork: runPlan.hasWork,
            confirmed: false,
            configFilePath: runPlan.context.configPath,
          },
          configPullPayloadFor(runPlan, { dryRun: false, declined: true }),
        ),
        pullMigrationHistoryStepResult({
          kind: "skipped",
          reason: shouldFetchMigrationHistory ? "declined" : "not_needed",
        }),
        pullDbStepResult({ kind: "planned" }),
        pullFunctionsStepResult({ kind: "planned" }),
      ];
      const aggregate = pullAggregate({
        ref,
        branch,
        dryRun: false,
        confirmed: false,
        dirtyPaths,
        results,
      });
      yield* pullEmit(output, aggregate);
      return;
    }

    // Each step is failure-isolated: one failing doesn't stop the rest from running and being
    // reported.
    const stepContext: PullStepContext = { ref, assumeYes: true };
    let firstFailureCause: Cause.Cause<PullStepFailureCause> | undefined;
    const results: Array<PullStepResult> = [];

    const configCapture = yield* pullCaptureStep(pullConfigStep({ runPlan, source }));
    if (configCapture.kind === "ok") {
      results.push(
        pullConfigStepResult(
          // `pullConfigStep` returns the plan's absolute `configFilePath`; overridden here to
          // the workdir-relative path, matching the dry-run/declined branches above.
          { ...configCapture.value, configFilePath: runPlan.context.configPath },
          configPullPayloadFor(runPlan, { dryRun: false, declined: false }),
        ),
      );
    } else {
      results.push(
        pullWithRetryHint(
          pullFailedStepResult("config", Cause.squash(configCapture.cause)),
          ref,
          plannedRemoteLabel,
        ),
      );
      firstFailureCause = configCapture.cause;
    }

    const migrationCapture = yield* pullCaptureStep(
      shouldFetchMigrationHistory
        ? pullMigrationHistoryStep(stepContext)
        : Effect.succeed<PullMigrationHistoryStepOutcome>({
            kind: "skipped",
            reason: "not_needed",
          }),
    );
    if (migrationCapture.kind === "ok") {
      results.push(pullMigrationHistoryStepResult(migrationCapture.value));
    } else {
      results.push(
        pullWithRetryHint(
          pullFailedStepResult(
            "migration_history",
            Cause.squash(migrationCapture.cause),
            cliSettings.workdir,
          ),
          ref,
          plannedRemoteLabel,
        ),
      );
      firstFailureCause ??= migrationCapture.cause;
    }

    const dbCapture = yield* pullCaptureStep(pullDbStep(stepContext));
    if (dbCapture.kind === "ok") {
      results.push(pullDbStepResult(dbCapture.value));
    } else {
      results.push(
        pullWithRetryHint(
          pullDbStepFailureResult(
            Cause.squash(dbCapture.cause),
            ref,
            plannedRemoteLabel,
            cliSettings.workdir,
          ),
          ref,
          plannedRemoteLabel,
        ),
      );
      firstFailureCause ??= dbCapture.cause;
    }

    const functionsCapture = yield* pullCaptureStep(pullFunctionsStep(stepContext));
    if (functionsCapture.kind === "ok") {
      results.push(pullFunctionsStepResult(functionsCapture.value));
    } else {
      results.push(
        pullWithRetryHint(
          pullFailedStepResult(
            "functions",
            Cause.squash(functionsCapture.cause),
            cliSettings.workdir,
          ),
          ref,
          plannedRemoteLabel,
        ),
      );
      firstFailureCause ??= functionsCapture.cause;
    }

    const aggregate = pullAggregate({
      ref,
      branch,
      dryRun: false,
      confirmed: true,
      dirtyPaths,
      results,
    });
    if (firstFailureCause === undefined) {
      yield* pullEmit(output, aggregate);
      return;
    }

    if (output.format === "text") {
      yield* output.raw(renderPullSummary(aggregate));
    } else {
      yield* machineErrorContext.set(pullPayload(aggregate));
    }
    return yield* Effect.failCause(firstFailureCause);
  }).pipe(
    // Telemetry flushes on every invocation, including target-resolution failures; the
    // linked-project cache write only fires once a ref has resolved.
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
