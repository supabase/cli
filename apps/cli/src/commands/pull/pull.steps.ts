import { Effect, Option, Stdio } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { aqua, bold, yellow } from "../../command-internal/colors.ts";
import { functionsLocalConfigLoader } from "../../command-internal/functions-local-config.ts";
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
import { runDbPull, type DbPullRunFlags } from "../../command-internal/db-pull-run.ts";
import { runMigrationFetch } from "../../command-internal/migration-fetch-run.ts";
import type {
  PullConfigStepOutcome,
  PullDbStepOutcome,
  PullFunctionsStepOutcome,
  PullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import type { PullStepContext } from "./pull.types.ts";

// One adapter per `PULL_STEP_ORDER` entry; each runs only after the aggregated confirmation.

/** `config` step: applies the planned config write, or skips it when the plan has no work. */
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
 * `migration_history` step: fetches the remote migration history into `supabase/migrations` from
 * `context.target` (ADR 0024); the orchestrator's confirmation replaces its overwrite prompt.
 */
export const pullMigrationHistoryStep = Effect.fnUntraced(function* (context: PullStepContext) {
  const cliSettings = yield* CommandSettings;
  const outcome = yield* runMigrationFetch({
    target: context.target,
    assumeYes: context.assumeYes,
  });
  return {
    kind: "fetched",
    outcome,
    workdir: cliSettings.workdir,
  } satisfies PullMigrationHistoryStepOutcome;
});

/**
 * `db` step: pulls the linked project's schema in migration mode under the orchestrator's consent.
 * `DbPullInSyncError` is reported as `in_sync`, a finding rather than a failure (ADR 0024).
 */
export const pullDbStep = Effect.fnUntraced(function* (context: PullStepContext) {
  const cliSettings = yield* CommandSettings;
  const flags: DbPullRunFlags = {
    name: Option.none(),
    declarative: Option.none(),
    diffEngine: Option.none(),
    strictCoverage: false,
    schema: [],
    password: Option.none(),
  };
  return yield* runDbPull(flags, context.target, { preapproved: context.preapproved }).pipe(
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
 * download` command's `--use-api`/`--use-docker` defaults. `resolveProjectRef` just returns the
 * already-resolved ref.
 */
export const pullFunctionsStep = Effect.fnUntraced(function* (context: PullStepContext) {
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(cliSettings.workdir);

  const result: DownloadFunctionsResult = yield* downloadFunctions(
    {
      functionName: Option.none(),
      useApi: false,
      useDocker: true,
    },
    {
      api,
      projectRoot: cliSettings.workdir,
      rawArgs,
      localConfigLoader: functionsLocalConfigLoader,
      edgeRuntimeVersion,
      styleEmphasis: (text) => bold(text),
      styleAqua: (text) => aqua(text),
      styleWarning: (text) => yellow(text),
      resolveProjectRef: Effect.succeed(context.ref),
    },
  );
  return { kind: "downloaded", result } satisfies PullFunctionsStepOutcome;
});
