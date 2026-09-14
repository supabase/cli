import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { aqua, bold, yellow } from "../../command-internal/colors.ts";
import { functionsGoConfigCompat } from "../../command-internal/functions-go-config.ts";
import {
  downloadFunctions,
  type DownloadFunctionsResult,
} from "../../shared/functions/download.ts";
import { resolveEdgeRuntimeVersionPin } from "../../shared/functions/functions.shared.ts";
import {
  applyConfigPullRun,
  type ConfigPullRunPlan,
  type ConfigPullSource,
} from "../../command-internal/config-pull-run.ts";
import { runDbPull, type DbPullFlags } from "../../command-internal/db-pull-run.ts";
import {
  runMigrationFetch,
  type MigrationFetchFlags,
} from "../../command-internal/migration-fetch-run.ts";
import type {
  PullConfigStepOutcome,
  PullDbStepOutcome,
  PullFunctionsStepOutcome,
  PullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import type { PullStepContext } from "./pull.types.ts";

/**
 * `supabase pull` step runners — one per `PULL_STEP_ORDER` entry, each a thin adapter over its
 * sub-step's own run-core. No confirmation, failure capture, or aggregation lives here: these
 * only run once the aggregated confirmation is accepted, so every one performs its side effect
 * (there's no internal dry-run/declined branch).
 */

/**
 * `config` step: applies the already-planned config write (skipped when the plan had no work)
 * and reports the fixed `{dryRun: false, confirmed: true}` shape `pullConfigStepResult` expects
 * for an executed run.
 */
export const pullConfigStep = Effect.fnUntraced(function* (input: {
  readonly runPlan: ConfigPullRunPlan;
  readonly source: ConfigPullSource;
}) {
  if (input.runPlan.hasWork) {
    yield* applyConfigPullRun({ runPlan: input.runPlan, source: input.source });
  }
  return {
    dryRun: false,
    hasWork: input.runPlan.hasWork,
    confirmed: true,
    configFilePath: input.runPlan.configFilePath,
  } satisfies PullConfigStepOutcome;
});

/**
 * `migration_history` step: fetches the remote migration history table into
 * `supabase/migrations`, targeting the already-resolved `context.ref` directly (ADR 0024) and
 * suppressing its own overwrite prompt with `assumeYes` since the orchestrator's confirmation
 * already covers it.
 */
export const pullMigrationHistoryStep = Effect.fnUntraced(function* (context: PullStepContext) {
  const cliSettings = yield* CommandSettings;
  const flags: MigrationFetchFlags = {
    dbUrl: Option.none(),
    linked: true,
    local: false,
    projectRef: Option.some(context.ref),
  };
  const outcome = yield* runMigrationFetch({
    flags,
    target: { setFlags: [], connType: "linked" },
    assumeYes: context.assumeYes,
  });
  return {
    kind: "fetched",
    outcome,
    workdir: cliSettings.workdir,
  } satisfies PullMigrationHistoryStepOutcome;
});

/**
 * `db` step: pulls the linked project's schema in migration mode, targeting `context.ref`
 * directly and suppressing `db pull`'s remote-history-update prompt with `assumeYes`.
 * `forceMigrationMode: true` prevents an ambient `--experimental` gate from silently switching to
 * the declarative export path, which `pull`'s dirty-check and confirmation don't guard against.
 * `DbPullInSyncError` is caught and reported as `in_sync`, a finding rather than a failure at the
 * `pull` level (ADR 0024).
 */
export const pullDbStep = Effect.fnUntraced(function* (context: PullStepContext) {
  const cliSettings = yield* CommandSettings;
  const flags: DbPullFlags = {
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
  return yield* runDbPull(flags, {
    assumeYes: context.assumeYes,
    forceMigrationMode: true,
  }).pipe(
    Effect.map((outcome): PullDbStepOutcome => ({
      kind: "applied",
      outcome,
      workdir: cliSettings.workdir,
    })),
    Effect.catchTag("DbPullInSyncError", () =>
      Effect.succeed<PullDbStepOutcome>({ kind: "in_sync" }),
    ),
  );
});

/**
 * `functions` step: downloads every Edge Function's source, matching the standalone `functions
 * download` command's `--use-api`/`--use-docker` defaults. `legacyBundle: false` keeps
 * `proxyDownload` unreachable, so `resolveProjectRef` just returns the already-resolved ref.
 */
export const pullFunctionsStep = Effect.fnUntraced(function* (context: PullStepContext) {
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
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
      goConfigCompat: functionsGoConfigCompat,
      edgeRuntimeVersion,
      styleEmphasis: (text) => bold(text),
      styleAqua: (text) => aqua(text),
      styleWarning: (text) => yellow(text),
      resolveProjectRef: () => Effect.succeed(context.ref),
      proxyDownload: () =>
        Effect.die(
          new Error(
            "supabase pull: functions download unexpectedly delegated to the Go binary (legacyBundle is always false for pull)",
          ),
        ),
    },
  );
  return { kind: "downloaded", result } satisfies PullFunctionsStepOutcome;
});
