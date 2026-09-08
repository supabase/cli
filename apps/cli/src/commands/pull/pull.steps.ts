import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../config/legacy-cli-settings.service.ts";
import { legacyAqua, legacyBold, legacyYellow } from "../../command-internal/legacy-colors.ts";
import { legacyFunctionsGoConfigCompat } from "../../command-internal/legacy-functions-go-config.ts";
import {
  downloadFunctions,
  type DownloadFunctionsResult,
} from "../../shared/functions/download.ts";
import { resolveEdgeRuntimeVersionPin } from "../../shared/functions/functions.shared.ts";
import {
  legacyApplyConfigPullRun,
  type LegacyConfigPullRunPlan,
  type LegacyConfigPullSource,
} from "../config/pull/pull.handler.ts";
import { legacyRunDbPull } from "../db/pull/pull.handler.ts";
import type { LegacyDbPullFlags } from "../db/pull/pull.command.ts";
import { legacyRunMigrationFetch } from "../migration/fetch/fetch.handler.ts";
import type { LegacyMigrationFetchFlags } from "../migration/fetch/fetch.command.ts";
import type {
  LegacyPullConfigStepOutcome,
  LegacyPullDbStepOutcome,
  LegacyPullFunctionsStepOutcome,
  LegacyPullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import type { LegacyPullStepContext } from "./pull.types.ts";

/**
 * `supabase pull` step runners — one per `LEGACY_PULL_STEP_ORDER` entry
 * (`pull.types.ts`). Each is a thin adapter over its sub-step's own run-core:
 * it calls the real implementation and shapes the result into the
 * `LegacyPullXStepOutcome` union `pull.aggregate.ts`'s mappers expect.
 *
 * No confirmation, `Exit`-based failure capture, or aggregation lives here —
 * that is `pull.handler.ts`'s job (Phase 3). These runners are only ever
 * called once the aggregated confirmation has already been accepted (or
 * `--yes` bypassed it), so every one of them actually performs its side
 * effect — there is no internal "dry run"/"declined" branch here; those
 * outcomes are built directly by `pull.handler.ts` from `pull.aggregate.ts`'s
 * mappers without ever reaching this module.
 */

/**
 * `config` step: applies the already-planned config write (skipped when the
 * plan had no work at all) and reports the fixed `{dryRun: false, confirmed:
 * true}` shape `legacyPullConfigStepResult` expects for an executed run — the
 * `dryRun`/declined variants of this outcome are built directly by
 * `pull.handler.ts` (Phase 1/2), never through this function.
 */
export const legacyPullConfigStep = Effect.fnUntraced(function* (input: {
  readonly runPlan: LegacyConfigPullRunPlan;
  readonly source: LegacyConfigPullSource;
}) {
  if (input.runPlan.hasWork) {
    yield* legacyApplyConfigPullRun({ runPlan: input.runPlan, source: input.source });
  }
  return {
    dryRun: false,
    hasWork: input.runPlan.hasWork,
    confirmed: true,
    configFilePath: input.runPlan.configFilePath,
  } satisfies LegacyPullConfigStepOutcome;
});

/**
 * `migration_history` step: fetches the remote migration history table into
 * `supabase/migrations` via `migration fetch`'s run-core, targeting the
 * already-resolved `context.ref` directly (`{setFlags: [], connType:
 * "linked"}` — resolve-once, per ADR 0024) and suppressing its own internal
 * overwrite prompt with `assumeYes` (the orchestrator's own confirmation
 * already covers this). Only called when the orchestrator decided this step
 * should actually run this invocation (`--with-migration-history`, or an
 * empty/missing `supabase/migrations`) — the "not needed" skip is built
 * directly by `pull.handler.ts`, never through this function.
 */
export const legacyPullMigrationHistoryStep = Effect.fnUntraced(function* (
  context: LegacyPullStepContext,
) {
  const cliSettings = yield* LegacyCliSettings;
  const flags: LegacyMigrationFetchFlags = {
    dbUrl: Option.none(),
    linked: true,
    local: false,
    projectRef: Option.some(context.ref),
  };
  const outcome = yield* legacyRunMigrationFetch({
    flags,
    target: { setFlags: [], connType: "linked" },
    assumeYes: context.assumeYes,
  });
  return {
    kind: "fetched",
    outcome,
    workdir: cliSettings.workdir,
  } satisfies LegacyPullMigrationHistoryStepOutcome;
});

/**
 * `db` step: pulls the linked project's schema in migration mode (no
 * `--declarative`/diff-engine override), targeting `context.ref` directly and
 * suppressing `db pull`'s own remote-history-update prompt with `assumeYes`.
 * `LegacyDbPullInSyncError` — the remote already matches local migrations —
 * is caught here and reported as `in_sync` (a finding, not a failure, at the
 * `pull` level per ADR 0024) rather than propagating to `pull.handler.ts`'s
 * failure-capture path.
 */
export const legacyPullDbStep = Effect.fnUntraced(function* (context: LegacyPullStepContext) {
  const cliSettings = yield* LegacyCliSettings;
  const flags: LegacyDbPullFlags = {
    name: Option.none(),
    declarative: Option.none(),
    usePgDelta: Option.none(),
    diffEngine: Option.none(),
    strictCoverage: false,
    schema: [],
    dbUrl: Option.none(),
    linked: Option.none(),
    local: Option.none(),
    projectRef: Option.some(context.ref),
    password: Option.none(),
  };
  return yield* legacyRunDbPull(flags, {
    assumeYes: context.assumeYes,
    skipFinishedLine: true,
  }).pipe(
    Effect.map(
      (outcome): LegacyPullDbStepOutcome => ({
        kind: "applied",
        outcome,
        workdir: cliSettings.workdir,
      }),
    ),
    Effect.catchTag("LegacyDbPullInSyncError", () =>
      Effect.succeed<LegacyPullDbStepOutcome>({ kind: "in_sync" }),
    ),
  );
});

/**
 * `functions` step: downloads every Edge Function's source from the linked
 * project via the shared `downloadFunctions` run-core, matching the
 * standalone `functions download` command's own `--use-api`/`--use-docker`
 * defaults. `legacyBundle` is always `false`, so `proxyDownload` is
 * unreachable and `resolveProjectRef` never re-resolves — the target ref was
 * already resolved once, up front, by the orchestrator.
 */
export const legacyPullFunctionsStep = Effect.fnUntraced(function* (
  context: LegacyPullStepContext,
) {
  const api = yield* LegacyPlatformApi;
  const cliSettings = yield* LegacyCliSettings;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(
    join(cliSettings.workdir, "supabase"),
  );

  const result: DownloadFunctionsResult = yield* downloadFunctions(
    {
      functionName: Option.none(),
      projectRef: Option.some(context.ref),
      useApi: false,
      useDocker: true,
      legacyBundle: false,
    },
    {
      api,
      projectRoot: cliSettings.workdir,
      rawArgs,
      goConfigCompat: legacyFunctionsGoConfigCompat,
      edgeRuntimeVersion,
      styleEmphasis: (text) => legacyBold(text),
      styleAqua: (text) => legacyAqua(text),
      styleWarning: (text) => legacyYellow(text),
      resolveProjectRef: () => Effect.succeed(context.ref),
      proxyDownload: () =>
        Effect.die(
          new Error(
            "supabase pull: functions download unexpectedly delegated to the Go binary (legacyBundle is always false for pull)",
          ),
        ),
    },
  );
  return { kind: "downloaded", result } satisfies LegacyPullFunctionsStepOutcome;
});
