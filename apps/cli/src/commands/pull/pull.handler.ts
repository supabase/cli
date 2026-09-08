import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";

import { LegacyCliSettings } from "../../config/legacy-cli-settings.service.ts";
import { legacyConfigFileHasUncommittedChanges } from "../../command-internal/legacy-git-status.ts";
import { mapLegacyHttpError } from "../../command-internal/legacy-http-errors.ts";
import { legacyLoadLocalVersions } from "../../command-internal/legacy-migration-history.ts";
import { legacyValidateWorkdirIsDirectory } from "../../command-internal/legacy-workdir-validation.ts";
import { MachineErrorContext } from "../../shared/output/machine-error-context.service.ts";
import { legacyResolveYes, LegacyOutputFlag } from "../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../shared/legacy/legacy-prompt-yes-no.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyConfigTargetErrorsFor, legacyResolveConfigTarget } from "../config/config.target.ts";
import { legacyUnexpectedStatusMessage } from "../config/config.read-status.ts";
import {
  legacyConfigPullPayload,
  legacyRenderConfigPullText,
  type LegacyConfigPullOutcome,
} from "../config/pull/pull.format.ts";
import {
  legacyOpenConfigPullSource,
  legacyPlanConfigPullRun,
  type LegacyConfigPullRunPlan,
} from "../config/pull/pull.handler.ts";
import {
  legacyPullConfigStep,
  legacyPullDbStep,
  legacyPullFunctionsStep,
  legacyPullMigrationHistoryStep,
} from "./pull.steps.ts";
import {
  legacyPullAggregate,
  legacyPullConfigStepResult,
  legacyPullDbStepResult,
  legacyPullFailedStepResult,
  legacyPullFunctionsStepResult,
  legacyPullMigrationHistoryStepResult,
  type LegacyPullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import {
  legacyPullConfirmMessage,
  legacyPullPayload,
  legacyPullSummaryMessage,
  legacyRenderPullSummary,
} from "./pull.format.ts";
import type { LegacyPullAggregate, LegacyPullStepContext, LegacyPullStepResult } from "./pull.types.ts";
import {
  LegacyPullBranchNotFoundError,
  LegacyPullBranchNotLinkedError,
  LegacyPullBranchNotReadyError,
  LegacyPullBranchResolveNetworkError,
  LegacyPullBranchResolveStatusError,
  LegacyPullOutputFlagUnsupportedError,
  LegacyPullParentRefInvalidError,
  LegacyPullUncommittedChangesError,
  LegacyPullWorkdirError,
} from "./pull.errors.ts";
import type { LegacyPullFlags } from "./pull.command.ts";

/** Error construction for `legacyResolveConfigTarget` (`../config/config.target.ts`),
 *  keeping `pull`'s own minted tagged error classes (`pull.errors.ts`). */
const pullTargetErrors = legacyConfigTargetErrorsFor({
  notLinked: LegacyPullBranchNotLinkedError,
  parentRefInvalid: LegacyPullParentRefInvalidError,
  branchNotFound: LegacyPullBranchNotFoundError,
  branchNotReady: LegacyPullBranchNotReadyError,
});

const mapBranchResolveError = mapLegacyHttpError({
  networkError: LegacyPullBranchResolveNetworkError,
  statusError: LegacyPullBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: legacyUnexpectedStatusMessage,
});

/** The config step's own machine payload, verbatim — `runPlan`'s fields plus
 *  the run's actual `{dryRun, declined}` disposition (unknown until the
 *  aggregated confirmation resolves). One call site so every one of the four
 *  places that builds a config `LegacyPullStepResult` (dry run, declined,
 *  and the real Phase 3 apply) shapes the payload identically. */
const legacyConfigPullPayloadFor = (
  runPlan: LegacyConfigPullRunPlan,
  outcome: LegacyConfigPullOutcome,
) =>
  legacyConfigPullPayload(runPlan.changeSet, runPlan.scope, runPlan.plan, runPlan.context, outcome);

/**
 * Emits the aggregate exactly like every non-failure disposition (dry run,
 * declined, or a fully-succeeded run) — text mode renders the aligned summary
 * block to stdout, machine mode reports one `output.success` envelope. The
 * mixed-failure disposition (Phase 4) does NOT use this: it needs the
 * text-mode render to still happen while machine mode instead feeds the
 * payload into `MachineErrorContext` ahead of a re-failed cause, so it is
 * inlined at that one call site instead of being folded in here.
 */
const legacyPullEmit = (output: typeof Output.Service, aggregate: LegacyPullAggregate) =>
  output.format === "text"
    ? output.raw(legacyRenderPullSummary(aggregate))
    : output.success(legacyPullSummaryMessage(aggregate), legacyPullPayload(aggregate));

/**
 * Runs `effect`, capturing a typed failure into `{kind: "failed", cause}`
 * instead of letting it propagate — but a defect or interruption in its
 * `Cause` propagates immediately via `Effect.failCause`, preserving the
 * original `Cause` (never swallowed as a mere per-step failure). Backs Phase
 * 3's partial-failure isolation: each of the four steps runs even when an
 * earlier one failed, and the ORIGINAL `Cause` of the first typed failure is
 * preserved (not rebuilt) for re-failing once every step has reported.
 */
function legacyPullCaptureStep<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly kind: "ok"; readonly value: A } | { readonly kind: "failed"; readonly cause: Cause.Cause<E> },
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
 * `supabase pull` — orchestrates `config pull`, an optional `migration
 * fetch`, `db pull`, and `functions download` behind one target resolution,
 * one confirmation, and one aggregated result (ADR 0024). See that ADR and
 * the command's `SIDE_EFFECTS.md` for the full side-effect inventory —
 * notably, the `db` step writes `supabase_migrations.schema_migrations` on
 * the REMOTE database, not just local files, and requires Docker.
 */
export const legacyPull = Effect.fn("legacy.pull")(function* (flags: LegacyPullFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const yes = yield* legacyResolveYes;
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const machineErrorContext = yield* MachineErrorContext;

  const requested = Option.filter(flags.projectRef, (value) => value.length > 0);

  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Phase 0.1: reject the Go-compat `-o/--output` flag outright — `pull` is
    // a net-new TS command with no Go parity contract (CLI-2156).
    if (Option.isSome(goOutputFlag)) {
      return yield* new LegacyPullOutputFlagUnsupportedError({
        message: "the -o/--output flag is not supported by pull; use --output-format json|stream-json instead.",
      });
    }

    // Phase 0.2: the resolved `--workdir`/`SUPABASE_WORKDIR` must exist and
    // be a directory before anything else — beats every step's own target
    // resolution and network calls.
    yield* legacyValidateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new LegacyPullWorkdirError({ message: error.message })),
    );

    // Phase 0.3-0.4: open the base config source, then resolve the pull
    // target exactly once — every sub-step below targets `ref` directly
    // instead of re-resolving (ADR 0024's "resolve once" decision).
    const source = yield* legacyOpenConfigPullSource();
    const { ref, branch } = yield* legacyResolveConfigTarget(
      requested,
      pullTargetErrors,
      mapBranchResolveError,
    );
    resolvedRef = ref;

    // Phase 1: preview. `legacyPlanConfigPullRun` does everything up through
    // the schema-validation gate — no git check, no prompt, no write.
    const runPlan = yield* legacyPlanConfigPullRun({
      target: { ref, branch },
      remoteLabel: undefined,
      source,
    });

    const dirty = flags.force
      ? false
      : Option.getOrElse(
          yield* legacyConfigFileHasUncommittedChanges(runPlan.configFilePath),
          () => false,
        );

    // Auto-run migration history whenever `supabase/migrations` is missing or
    // empty, even without `--with-migration-history` — the confirmed
    // bootstrap-auto-run decision (ADR 0024): there is nothing to overwrite,
    // and it is what makes a fresh checkout work by default.
    const shouldFetchMigrationHistory = flags.withMigrationHistory
      ? true
      : (yield* legacyLoadLocalVersions(
          fs,
          path,
          path.join(cliSettings.workdir, "supabase", "migrations"),
        )).length === 0;
    const migrationHistoryReason: "flag" | "bootstrap" | undefined = !shouldFetchMigrationHistory
      ? undefined
      : flags.withMigrationHistory
        ? "flag"
        : "bootstrap";

    // Phase 2: one confirmation, asymmetric preview (a real diff for config,
    // a qualitative description for db/functions/migration-history).
    const configDiffText = runPlan.hasWork
      ? legacyRenderConfigPullText(
          runPlan.changeSet,
          runPlan.scope,
          runPlan.plan,
          ref,
          runPlan.context.configPath,
        )
      : undefined;
    const confirmBody = legacyPullConfirmMessage({
      configDiffText,
      willFetchMigrationHistory: shouldFetchMigrationHistory,
      migrationHistoryReason,
      dirty,
    });

    if (flags.dryRun) {
      const results: ReadonlyArray<LegacyPullStepResult> = [
        legacyPullConfigStepResult(
          {
            dryRun: true,
            hasWork: runPlan.hasWork,
            confirmed: false,
            configFilePath: runPlan.configFilePath,
          },
          legacyConfigPullPayloadFor(runPlan, { dryRun: true, declined: false }),
        ),
        legacyPullMigrationHistoryStepResult(
          shouldFetchMigrationHistory ? { kind: "planned" } : { kind: "skipped", reason: "not_needed" },
        ),
        legacyPullDbStepResult({ kind: "planned" }),
        legacyPullFunctionsStepResult({ kind: "planned" }),
      ];
      const aggregate = legacyPullAggregate({ ref, branch, dryRun: true, confirmed: false, results });
      yield* legacyPullEmit(output, aggregate);
      return;
    }

    if (dirty) {
      const tty = yield* Tty;
      if (yes || output.format !== "text" || !tty.stdinIsTty) {
        return yield* new LegacyPullUncommittedChangesError({
          message: `${runPlan.context.configPath} has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.`,
        });
      }
    }

    if (output.format === "text") {
      yield* output.raw(confirmBody);
    }
    const confirmed = yield* legacyPromptYesNo(output, yes, "Proceed with pull?", dirty ? false : true);
    if (!confirmed) {
      const results: ReadonlyArray<LegacyPullStepResult> = [
        legacyPullConfigStepResult(
          {
            dryRun: false,
            hasWork: runPlan.hasWork,
            confirmed: false,
            configFilePath: runPlan.configFilePath,
          },
          legacyConfigPullPayloadFor(runPlan, { dryRun: false, declined: true }),
        ),
        legacyPullMigrationHistoryStepResult({
          kind: "skipped",
          reason: shouldFetchMigrationHistory ? "declined" : "not_needed",
        }),
        legacyPullDbStepResult({ kind: "planned" }),
        legacyPullFunctionsStepResult({ kind: "planned" }),
      ];
      const aggregate = legacyPullAggregate({ ref, branch, dryRun: false, confirmed: false, results });
      yield* legacyPullEmit(output, aggregate);
      return;
    }

    // Phase 3: execute. Each step is failure-isolated — one failing does not
    // stop the rest from running and being reported.
    const stepContext: LegacyPullStepContext = { ref, branch, dryRun: false, assumeYes: true };
    let firstFailureCause: Cause.Cause<unknown> | undefined;
    const results: Array<LegacyPullStepResult> = [];

    const configCapture = yield* legacyPullCaptureStep(legacyPullConfigStep({ runPlan, source }));
    if (configCapture.kind === "ok") {
      results.push(
        legacyPullConfigStepResult(
          configCapture.value,
          legacyConfigPullPayloadFor(runPlan, { dryRun: false, declined: false }),
        ),
      );
    } else {
      results.push(legacyPullFailedStepResult("config", Cause.squash(configCapture.cause)));
      firstFailureCause = configCapture.cause;
    }

    const migrationCapture = yield* legacyPullCaptureStep(
      shouldFetchMigrationHistory
        ? legacyPullMigrationHistoryStep(stepContext)
        : Effect.succeed<LegacyPullMigrationHistoryStepOutcome>({
            kind: "skipped",
            reason: "not_needed",
          }),
    );
    if (migrationCapture.kind === "ok") {
      results.push(legacyPullMigrationHistoryStepResult(migrationCapture.value));
    } else {
      results.push(
        legacyPullFailedStepResult("migration_history", Cause.squash(migrationCapture.cause)),
      );
      firstFailureCause ??= migrationCapture.cause;
    }

    const dbCapture = yield* legacyPullCaptureStep(legacyPullDbStep(stepContext));
    if (dbCapture.kind === "ok") {
      results.push(legacyPullDbStepResult(dbCapture.value));
    } else {
      results.push(legacyPullFailedStepResult("db", Cause.squash(dbCapture.cause)));
      firstFailureCause ??= dbCapture.cause;
    }

    const functionsCapture = yield* legacyPullCaptureStep(legacyPullFunctionsStep(stepContext));
    if (functionsCapture.kind === "ok") {
      results.push(legacyPullFunctionsStepResult(functionsCapture.value));
    } else {
      results.push(legacyPullFailedStepResult("functions", Cause.squash(functionsCapture.cause)));
      firstFailureCause ??= functionsCapture.cause;
    }

    // Phase 4: aggregate, emit, exit.
    const aggregate = legacyPullAggregate({ ref, branch, dryRun: false, confirmed: true, results });
    if (firstFailureCause === undefined) {
      yield* legacyPullEmit(output, aggregate);
      return;
    }

    if (output.format === "text") {
      yield* output.raw(legacyRenderPullSummary(aggregate));
    } else {
      yield* machineErrorContext.set(legacyPullPayload(aggregate));
    }
    return yield* Effect.failCause(firstFailureCause);
  }).pipe(
    // Legacy Shell Invariant #1: telemetry flushes on EVERY invocation,
    // including target-resolution failures; the linked-project cache write
    // only fires once a ref has actually resolved.
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
