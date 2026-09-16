import { join } from "node:path";
import type { ConfigFormat } from "@supabase/config";
import { Effect, Option, Path, Stdio } from "effect";

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
import { resolveExperimentalFeature } from "../../command-internal/experimental-feature.ts";
import {
  createComputeDownload,
  fetchBuildContext,
  listCompute,
} from "../../shared/compute/compute-api.ts";
import { readComputeSection } from "../../shared/compute/compute-config.ts";
import {
  applyComputePull,
  computePullMissingSource,
  planComputePull,
  restoreComputeSource,
  type ComputePullPlan,
} from "../../shared/compute/compute-pull.ts";
import { computeDir, computeSourceDir } from "../../shared/compute/compute-paths.ts";
import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import type {
  PullComputeStepOutcome,
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

/** What the `compute` step will do this invocation, known before the confirmation renders. */
export interface PullComputePlan {
  readonly plan: ComputePullPlan;
  readonly missingSource: ReadonlyArray<string>;
  /** `["remotes", label]` when the config step's destination is a remote block, `[]` otherwise. */
  readonly destinationPath: ReadonlyArray<string>;
  /**
   * Where each deployed compute's code belongs — `[compute.<name>] source` when recorded,
   * `supabase/compute/<name>/` otherwise. Resolved during planning so the confirmation can name
   * the directories a restore will write into, and so an unusable `source` is refused before
   * anything is downloaded.
   */
  readonly sourceDirs: Readonly<Record<string, string>>;
}

/** A plain object — a `[compute]` table rather than a scalar or a list. */
function isDocumentRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Plans the `compute` step: resolves the experimental gate, lists what the project has deployed,
 * and diffs it against what the config declares. `undefined` when compute is off for this
 * project — the gate is checked before the API call, so a project without the feature never
 * reaches `/v2/projects/{ref}/compute`.
 *
 * Unlike `db`/`migration_history`/`functions`, this step can preview for the price of one GET,
 * so it is planned ahead of the aggregated confirmation and shows a real per-compute diff there.
 */
export const planComputePullStep = Effect.fnUntraced(function* (input: {
  readonly ref: string;
  readonly source: ConfigPullSource;
  readonly destination: ConfigPullRunPlan["context"]["destination"];
}) {
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;

  const enabled = yield* resolveExperimentalFeature({
    feature: "compute",
    configValue: Effect.succeed(input.source.loaded.config.experimental?.compute),
    env: process.env,
  });
  if (!enabled) {
    return undefined;
  }

  const deployed = yield* listCompute(api, input.ref);

  const rawDocument = input.source.loaded.rawDocument;
  const remotes = isDocumentRecord(rawDocument) ? rawDocument["remotes"] : undefined;
  const destinationPath =
    input.destination.kind === "remote" ? ["remotes", input.destination.label] : [];
  const blockDocument =
    input.destination.kind === "remote" && isDocumentRecord(remotes)
      ? remotes[input.destination.label]
      : undefined;

  const plan = planComputePull({ deployed, rootDocument: rawDocument, blockDocument });

  // Read off the decoded, `env()`-resolved config rather than the raw document: this asks where
  // the code actually lives, which is the interpolated answer, not the literal spelling.
  const configured = readComputeSection(input.source.loaded.config.compute).compute;
  const missingSource = yield* computePullMissingSource({
    projectRoot: cliSettings.workdir,
    names: plan.deployed,
    configuredSource: (name) => configured[name]?.source,
  });

  // Confined here, before any download: `computeSourceDir` refuses a recorded `source` that
  // escapes the project, so a hostile `config.toml` cannot redirect a restore outside the tree.
  const path = yield* Path.Path;
  const sourceDirs: Record<string, string> = {};
  for (const name of plan.deployed) {
    sourceDirs[name] = yield* computeSourceDir({
      projectRoot: cliSettings.workdir,
      defaultDir: computeDir(path, cliSettings.workdir, name),
      name,
      configuredSource: configured[name]?.source,
    });
  }

  return { plan, missingSource, destinationPath, sourceDirs } satisfies PullComputePlan;
});

/**
 * Restores every deployed compute's source, one archive per compute.
 *
 * A compute with no readable build context is reported, not failed: the download route is a
 * newer addition than the compute API itself, and a deployment that cannot serve a context
 * leaves a pull with nothing to unpack while its config reconciliation is perfectly valid.
 * An archive that *is* served but cannot be safely unpacked is a different matter and fails —
 * see `restoreComputeSource`.
 */
const pullComputeSourceStep = Effect.fnUntraced(function* (input: {
  readonly ref: string;
  readonly names: ReadonlyArray<string>;
  readonly sourceDirs: Readonly<Record<string, string>>;
}) {
  const cliSettings = yield* CommandSettings;
  const credentials = yield* CommandCredentials;
  const accessToken = yield* credentials.getAccessToken;

  const restored: Array<string> = [];
  const unavailable: Array<string> = [];

  for (const name of input.names) {
    const destination = input.sourceDirs[name];
    if (destination === undefined) {
      continue;
    }
    const slot = yield* createComputeDownload({
      apiUrl: cliSettings.apiUrl,
      accessToken,
      userAgent: cliSettings.userAgent,
      projectRef: input.ref,
      name,
    });
    if (Option.isNone(slot)) {
      unavailable.push(name);
      continue;
    }
    const archive = yield* fetchBuildContext(slot.value);
    yield* restoreComputeSource({ name, destination, archive });
    restored.push(name);
  }

  return { restored, unavailable };
});

/**
 * `compute` step: records the deployed compute specs the plan already computed into
 * `[compute.<name>]`. Runs last, after the config step has finished rewriting the same file —
 * `applyComputePull` re-reads it so this write lands on top of that one rather than over it.
 * A converged plan writes nothing and still reports the reconciliation it checked.
 */
export const pullComputeStep = Effect.fnUntraced(function* (input: {
  readonly ref: string;
  readonly plan: ComputePullPlan;
  readonly missingSource: ReadonlyArray<string>;
  readonly sourceDirs: Readonly<Record<string, string>>;
  readonly configFilePath: string;
  readonly configPath: string;
  readonly format: ConfigFormat;
  readonly destinationPath: ReadonlyArray<string>;
  readonly workdir: string;
}) {
  if (input.plan.hasWork) {
    yield* applyComputePull({
      plan: input.plan,
      configFilePath: input.configFilePath,
      configPath: input.configPath,
      format: input.format,
      destinationPath: input.destinationPath,
    });
  }

  // Source last: the config entry is what records the compute's `source`, so writing the code
  // after it means a restore always lands where the just-written config says it belongs.
  const source = yield* pullComputeSourceStep({
    ref: input.ref,
    names: input.plan.deployed,
    sourceDirs: input.sourceDirs,
  });

  return {
    kind: "recorded",
    plan: input.plan,
    missingSource: input.missingSource,
    configFilePath: input.configPath,
    restored: source.restored.map((name) =>
      relativeToWorkdir(input.workdir, input.sourceDirs[name] ?? name),
    ),
    sourceUnavailable: source.unavailable,
  } satisfies PullComputeStepOutcome;
});

/** Workdir-relative display path, matching how every other step reports what it wrote. */
function relativeToWorkdir(workdir: string, target: string): string {
  return target.startsWith(workdir) ? target.slice(workdir.length).replace(/^[/\\]/, "") : target;
}
