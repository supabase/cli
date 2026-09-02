import {
  CLI_CONFIG_SCHEMA_URL,
  fromApiProjectConfig,
  ProjectConfigParseError,
  type LoadedCliConfig,
  type ProjectConfig,
} from "@supabase/config";
import {
  applyConfigEdits,
  type ConfigEdit,
  diffProjectConfig,
  loadCliConfig,
  writeCliConfigDocumentText,
} from "@supabase/config/internal";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import {
  legacyParentNotLinkedMessage,
  legacyParentRefInvalidMessage,
  legacyParentRefTypoHint,
} from "../../../shared/legacy-parent-project-ref.ts";
import { legacyConfigFileHasUncommittedChanges } from "../../../shared/legacy-git-status.ts";
import {
  legacySanitizeInlineName,
  mapLegacyHttpError,
  sanitizeLegacyErrorBody,
} from "../../../shared/legacy-http-errors.ts";
import { LEGACY_BRANCH_UUID_PATTERN } from "../../../shared/legacy-ref-patterns.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYes, LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { legacyResolveConfigTarget, type LegacyConfigTarget } from "../config.target.ts";
import {
  legacyConfigApiScope,
  legacyConfigRenderPath,
  legacyConfigScopeLine,
} from "../config.format.ts";
import {
  legacyConfigPullDestinationLine,
  legacyConfigPullPayload,
  legacyConfigPullSummaryMessage,
  legacyRenderConfigPullText,
  type LegacyConfigPullContext,
  type LegacyConfigPullOutcome,
} from "./pull.format.ts";
import {
  legacyPlanConfigPull,
  type LegacyConfigPullPlan,
  type LegacyConfigPullWarning,
} from "./pull.plan.ts";
import { legacyResolveConfigPullDestination } from "./pull.scope.ts";
import {
  LegacyConfigPullBranchNotFoundError,
  LegacyConfigPullBranchNotLinkedError,
  LegacyConfigPullBranchNotReadyError,
  LegacyConfigPullFileChangedError,
  LegacyConfigPullLoadConfigError,
  LegacyConfigPullOutputFlagUnsupportedError,
  LegacyConfigPullParentRefInvalidError,
  LegacyConfigPullReadNetworkError,
  LegacyConfigPullReadStatusError,
  LegacyConfigPullRemoteEnvRefError,
  LegacyConfigPullRemoteLabelCollisionError,
  LegacyConfigPullUncommittedChangesError,
  LegacyConfigPullUnsupportedLayoutError,
  LegacyConfigPullWriteError,
} from "./pull.errors.ts";
import type { LegacyConfigPullFlags } from "./pull.command.ts";

/**
 * `config pull` — writes a remote project or branch's configuration into
 * `supabase/config.toml`/`.json` (root, or an existing/new `[remotes.*]`
 * block), after a confirmation prompt. Mirrors `config diff`'s target
 * resolution, fetch, and classify steps (`../diff/diff.handler.ts`)
 * step-for-step through the point where the two commands diverge (CLI-2064).
 *
 * Library seam (plan §1.6, adapted): `legacyConfigPull` (steps 1-4) rejects
 * `-o/--output`, loads and validates the local config BEFORE any network
 * call or target resolution, snapshots the file's on-disk text once, then
 * resolves the target and delegates to `legacyRunConfigPull` (steps 5-15) —
 * the reusable, target-agnostic body. The plan's own `LegacyConfigPullInput`
 * sketch omits the loaded config/file text; this implementation carries them
 * through explicitly instead of reloading/re-reading inside
 * `legacyRunConfigPull`, since `legacyConfigPull` already holds both by the
 * time it delegates (see {@link LegacyConfigPullInput}'s own doc comments).
 */

const readStatusMessage = (status: number, body: string) => `unexpected status ${status}: ${body}`;

const mapBranchResolveError = mapLegacyHttpError({
  networkError: LegacyConfigPullReadNetworkError,
  statusError: LegacyConfigPullReadStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: readStatusMessage,
});

/** Error construction for `legacyResolveConfigTarget` (`../config.target.ts`),
 * keeping `config pull`'s own tagged error classes and message wording
 * (mirrors `config diff`'s `configTargetErrors`). */
const configTargetErrors = {
  notLinked: (target: string) =>
    new LegacyConfigPullBranchNotLinkedError({ message: legacyParentNotLinkedMessage(target) }),
  parentRefInvalid: (target: string) =>
    new LegacyConfigPullParentRefInvalidError({ message: legacyParentRefInvalidMessage(target) }),
  branchNotFound: (target: string) =>
    new LegacyConfigPullBranchNotFoundError({
      message: `Branch "${legacySanitizeInlineName(target)}" not found. Run \`supabase branches list\` to see available branches.${legacyParentRefTypoHint(target)}`,
    }),
  branchNotReady: (target: string) =>
    new LegacyConfigPullBranchNotReadyError({
      message: `Branch "${legacySanitizeInlineName(target)}" has no project ref yet. Wait for it to finish provisioning, then retry.`,
    }),
  mapResolveError: mapBranchResolveError,
};

/**
 * Purpose-written messages for the config-read status codes a wrong or
 * inaccessible ref most plausibly produces — copied verbatim from `config
 * diff` (`../diff/diff.handler.ts`); every other status keeps the generic
 * `unexpected status N: body` shape.
 */
function configReadStatusMessage(status: number, body: string, ref: string): string {
  if (status === 401) {
    return "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.";
  }
  if (status === 403) {
    return `Access denied for project ${legacySanitizeInlineName(ref)}: your account does not have permission to view its configuration.`;
  }
  if (status === 404) {
    return `Project ${legacySanitizeInlineName(ref)} not found. Check the project ref, or run \`supabase projects list\` to see the projects you have access to.`;
  }
  return readStatusMessage(status, body);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

/**
 * Deep-copies `root`, replacing the value at `path` — used ONLY by
 * {@link legacyConfigPullConvergenceCheck} to build the "projected next
 * document"/config in memory (plan §1.9); never to produce bytes written to
 * disk (`applyConfigEdits` owns that). The exported-shaped overload preserves
 * the input's own type (a deep-set never changes an object's shape, only a
 * leaf value); the implementation itself is intentionally untyped, mirroring
 * `@supabase/config`'s own split between a typed overload contract and a
 * structurally-unverifiable recursive implementation (e.g.
 * `fromConfigDocument`, `config-edit.ts`'s own `deepSetOne`).
 */
function deepSetAtPath<T>(root: T, path: ReadonlyArray<string>, value: unknown): T;
function deepSetAtPath(root: unknown, path: ReadonlyArray<string>, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const head = path[0];
  if (head === undefined) {
    return value;
  }
  const rest = path.slice(1);
  const base: Record<string, unknown> = isRecord(root) ? root : {};
  return { ...base, [head]: deepSetAtPath(base[head], rest, value) };
}

/**
 * Plan §1.9's convergence check, run once planning is done and BEFORE
 * `--dry-run` returns (a planner defect must be caught even in a preview
 * run): applies every planned write to a deep-copied projection of `loaded`
 * (config + document, never `applyConfigEdits`'s text span editor) and diffs
 * THAT again against `remote`.
 *
 * A residual change at a path this run just planned to write means the write
 * didn't actually converge — a bug in this planner, not a user-facing
 * failure, so it dies. A residual `unmanaged` path (ADR 0021's unpushable
 * families, e.g. `auth.oauth_server` on its first pull: undeclared before
 * this run, so it planned normally, but DECLARING it makes
 * `applyPushUnmanagedOmissions` drop it from every future comparison) is
 * expected, not a defect — `config push` has no code path for these fields,
 * so a written value there can never be sent back. Surfaced as a
 * `"unpushable"` warning, reusing the SAME `plan.warnings` /
 * `legacyRenderConfigPullText` "Warnings:" hook the planner's own
 * `dual_scope`/`duplicates_root`/`array_drift` warnings already render
 * through, rather than adding a new payload field.
 */
function legacyConfigPullConvergenceCheck(
  plan: LegacyConfigPullPlan,
  loaded: LoadedCliConfig,
  remote: ProjectConfig,
): Effect.Effect<LegacyConfigPullPlan> {
  if (plan.writes.length === 0) {
    return Effect.succeed(plan);
  }
  return Effect.gen(function* () {
    const nextConfig = plan.writes.reduce(
      (config, write) => deepSetAtPath(config, write.change.path, write.value),
      loaded.config,
    );
    const nextDocument = plan.writes.reduce(
      (document, write) => deepSetAtPath(document, write.change.path, write.value),
      loaded.document ?? {},
    );
    const residual = yield* Effect.try({
      try: () =>
        diffProjectConfig({
          local: { config: nextConfig, document: nextDocument, valueOrigins: loaded.valueOrigins },
          remote,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.orDie);

    const writtenPathKeys = new Set(plan.writes.map((write) => pathKey(write.change.path)));
    const stillDrifting = residual.changes.filter((change) =>
      writtenPathKeys.has(pathKey(change.path)),
    );
    if (stillDrifting.length > 0) {
      return yield* Effect.die(
        new Error(
          `config pull planner defect: still differs from remote after applying the planned write: ${stillDrifting
            .map((change) => legacyConfigRenderPath(change.path))
            .join(", ")}`,
        ),
      );
    }

    const unpushableWarnings: ReadonlyArray<LegacyConfigPullWarning> = residual.unmanaged
      .filter((path) => writtenPathKeys.has(pathKey(path)))
      .map((path) => ({ kind: "unpushable", path }));

    return unpushableWarnings.length === 0
      ? plan
      : { ...plan, warnings: [...plan.warnings, ...unpushableWarnings] };
  });
}

/** Builds the file-load helpers for one `cliSettings.workdir` — a small
 * factory rather than a shared closure so both `legacyConfigPull` (step 2)
 * and `legacyRunConfigPull` (step 6's conditional reload) get their own,
 * independently testable copy without threading `cliSettings` through
 * {@link LegacyConfigPullInput}. */
function makeConfigLoader(cliSettings: { readonly workdir: string }) {
  // `cause.path` is anchored under the workdir; render it relative so the
  // message reads `supabase/config.json` like the family's other messages,
  // regardless of invocation cwd (mirrors `config diff`).
  const relativeConfigPath = (path: string): string =>
    path.startsWith(cliSettings.workdir)
      ? path.slice(cliSettings.workdir.length).replace(/^[/\\]/, "")
      : path;

  const loadLocalConfig = (projectRef: string | undefined) =>
    loadCliConfig(cliSettings.workdir, { projectRef, goViperCompat: true }).pipe(
      Effect.catchTag(
        "CliConfigParseError",
        (cause) =>
          new LegacyConfigPullLoadConfigError({
            message: `failed to parse ${relativeConfigPath(cause.path)}: ${String(cause.cause)}`,
          }),
      ),
      Effect.catchTag(
        "DuplicateRemoteProjectIdError",
        (cause) => new LegacyConfigPullLoadConfigError({ message: cause.message }),
      ),
      Effect.flatMap((loaded) =>
        loaded === null
          ? Effect.fail(
              new LegacyConfigPullLoadConfigError({
                message:
                  "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
              }),
            )
          : Effect.succeed(loaded),
      ),
    );

  return { relativeConfigPath, loadLocalConfig };
}

/**
 * Steps 5-15 of `config pull`, reusable independently of the CLI flag
 * surface (plan §1.6's library seam) — everything AFTER the target is known.
 */
export interface LegacyConfigPullInput {
  readonly target: LegacyConfigTarget;
  /** `--remote-label`, already filtered so an empty value reads as absent. */
  readonly remoteLabel: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
  /** `--yes` OR `SUPABASE_YES` (the GLOBAL flag — `legacyResolveYes`, no
   * project-`.env` fallback: unlike `config push`, this command never loads
   * one). */
  readonly yes: boolean;
  /**
   * The BASE config load (`legacyConfigPull` step 2) — no `[remotes.*]`
   * overlay applied, regardless of `target`. Deviates from the plan §1.6
   * sketch (`{target, remoteLabel, dryRun, force, yes}`): the load must
   * happen BEFORE target resolution (a malformed config must not burn a
   * branch-resolution round trip), so `legacyConfigPull` already holds it by
   * the time it delegates here — passed through rather than reloaded.
   */
  readonly baseLoaded: LoadedCliConfig;
  /**
   * The config file's exact on-disk text, read once immediately after the
   * base load (`legacyConfigPull` step 3) — the same bytes `applyConfigEdits`
   * edits (step 13), and the baseline this function re-reads before writing,
   * to detect a concurrent edit (step 12). Same deviation rationale as
   * {@link baseLoaded}.
   */
  readonly originalText: string;
}

export const legacyRunConfigPull = Effect.fnUntraced(function* (input: LegacyConfigPullInput) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const { ref, branch } = input.target;
  const { loadLocalConfig, relativeConfigPath } = makeConfigLoader(cliSettings);

  // 5. Resolve WHERE this pull writes (root vs. an existing/new
  // `[remotes.*]` block) — pure, no network call — then print the
  // destination line to stderr BEFORE any network call.
  const branchLabelCandidate =
    branch !== undefined && !LEGACY_BRANCH_UUID_PATTERN.test(branch) ? branch : undefined;
  const scopeResult = legacyResolveConfigPullDestination({
    rawRemotes: input.baseLoaded.rawDocument?.["remotes"],
    interpolatedRemotes: input.baseLoaded.interpolatedRemotes,
    projectRef: ref,
    branchLabelCandidate,
    targetWasBranch: branch !== undefined,
    requestedLabel: input.remoteLabel,
  });
  if (!scopeResult.ok) {
    if (scopeResult.reason === "label_collision") {
      return yield* new LegacyConfigPullRemoteLabelCollisionError({
        message: `--remote-label "${legacySanitizeInlineName(scopeResult.label)}" already tracks project ${legacySanitizeInlineName(scopeResult.conflictingProjectId)}; pass a different --remote-label, or drop the flag to reuse the block that already tracks this project.`,
      });
    }
    return yield* new LegacyConfigPullRemoteEnvRefError({
      message: `[remotes.${legacySanitizeInlineName(scopeResult.label)}].project_id resolves to this project via env(${scopeResult.envVariables.map((name) => legacySanitizeInlineName(name)).join(", ")}), but config pull never reuses or rewrites an env()-spelled match. Replace it with the literal project ref, or pass --remote-label to target a different block.`,
    });
  }
  const destination = scopeResult.destination;
  yield* output.raw(
    legacyConfigPullDestinationLine({ projectRef: ref, branch }, destination),
    "stderr",
  );

  // 6. Reload WITH the `[remotes.*]` overlay only when block reuse selected
  // an EXISTING block — a brand-new block has nothing to overlay yet.
  let loaded = input.baseLoaded;
  if (destination.kind === "remote" && !destination.created) {
    loaded = yield* loadLocalConfig(ref);
  }

  const context: LegacyConfigPullContext = {
    projectRef: ref,
    branch,
    configSchema: loaded.schemaRef ?? CLI_CONFIG_SCHEMA_URL,
    configPath: relativeConfigPath(loaded.path),
    format: loaded.format,
    appliedRemote: loaded.appliedRemote,
    destination,
  };

  // 7. Fetch the effective remote config — verbatim from `config diff`
  // (ADR 0019 rule 2: `executeRaw` + lenient decode boundary; the caller
  // owns the status check, `fromApiProjectConfig`'s lenient decode owns the
  // body).
  const fetching =
    output.format === "text" ? yield* output.task("Fetching remote config...") : undefined;
  const response = yield* api.executeRaw(operationDefinitions.v2GetProjectConfig, { ref }).pipe(
    Effect.tapError(() => fetching?.fail() ?? Effect.void),
    Effect.mapError(
      (cause) =>
        new LegacyConfigPullReadNetworkError({
          message: `failed to read project config: ${cause}`,
        }),
    ),
  );
  if (response.status !== 200) {
    const body = sanitizeLegacyErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
    yield* fetching?.fail() ?? Effect.void;
    return yield* new LegacyConfigPullReadStatusError({
      status: response.status,
      body,
      message: configReadStatusMessage(response.status, body, ref),
    });
  }
  const responseJson = yield* response.json.pipe(
    Effect.tapError(() => fetching?.fail() ?? Effect.void),
    Effect.mapError(
      (cause) =>
        new LegacyConfigPullReadNetworkError({
          message: `failed to read project config: ${cause}`,
          decode: true,
        }),
    ),
  );
  yield* fetching?.clear() ?? Effect.void;

  // Project the response through CLI-2230's convergence normalizer (ADR
  // 0021) and classify — same typed/defect boundary as `config diff`.
  const remote = yield* Effect.try({
    try: () => fromApiProjectConfig(responseJson),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
  const changeSet = yield* Effect.try({
    try: () => diffProjectConfig({ local: loaded, remote }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );

  const data = isRecord(responseJson) ? responseJson["data"] : undefined;
  const scope = legacyConfigApiScope(
    isRecord(data) && isRecord(data["attributes"]) ? data["attributes"] : {},
  );
  yield* output.raw(legacyConfigScopeLine(scope), "stderr");

  // 8. Plan the writes, then run the convergence check (plan §1.9).
  const plan = legacyPlanConfigPull({
    changeSet,
    destination,
    rootDocument: input.baseLoaded.document ?? {},
    projectRef: ref,
  });
  const planWithUnpushable = yield* legacyConfigPullConvergenceCheck(plan, loaded, remote);

  const emitOutcome = (planForOutput: LegacyConfigPullPlan, outcome: LegacyConfigPullOutcome) =>
    output.format !== "text"
      ? output.success(
          legacyConfigPullSummaryMessage(changeSet, scope, planForOutput, outcome),
          legacyConfigPullPayload(changeSet, scope, planForOutput, context, outcome),
        )
      : output.raw(`${legacyConfigPullSummaryMessage(changeSet, scope, planForOutput, outcome)}\n`);

  // 9. `--dry-run`: preview only. Never runs the git check, never prompts,
  // never touches the file.
  if (input.dryRun) {
    if (output.format === "text") {
      yield* output.raw(legacyRenderConfigPullText(changeSet, scope, planWithUnpushable));
    }
    yield* emitOutcome(planWithUnpushable, { dryRun: true, declined: false });
    return;
  }

  // 10. Git dirty guard (plan §1.4). `--force` skips it entirely — no
  // check, no warning, no prompt-default flip.
  let dirty = false;
  if (!input.force) {
    const dirtyOption = yield* legacyConfigFileHasUncommittedChanges(loaded.path);
    dirty = Option.getOrElse(dirtyOption, () => false);
    if (dirty) {
      const tty = yield* Tty;
      if (output.format !== "text" || !tty.stdinIsTty) {
        return yield* new LegacyConfigPullUncommittedChangesError({
          message: `${context.configPath} has uncommitted changes. Commit or stash them first, or rerun with --force to write anyway.`,
        });
      }
    }
  }
  // Reuses the SAME `plan.warnings` hook the planner's own path-scoped
  // warnings render through (`legacyRenderConfigPullText`'s "Warnings:"
  // section) — a repository-level warning, no `path`.
  const planForRender: LegacyConfigPullPlan = dirty
    ? {
        ...planWithUnpushable,
        warnings: [...planWithUnpushable.warnings, { kind: "uncommitted_changes" }],
      }
    : planWithUnpushable;

  if (output.format === "text") {
    yield* output.raw(legacyRenderConfigPullText(changeSet, scope, planForRender));
  }

  // 11. Nothing planned — success, no prompt.
  if (planForRender.writes.length === 0) {
    yield* emitOutcome(planForRender, { dryRun: false, declined: false });
    return;
  }

  const confirmed = yield* legacyPromptYesNo(
    output,
    input.yes,
    `Apply ${planForRender.writes.length} change(s) to ${context.configPath}?`,
    dirty ? false : true,
  );
  if (!confirmed) {
    // Mirrors `config push`'s own treatment of a declined confirmation (each
    // service is marked "skipped" and the command still succeeds) — a
    // decline is a normal, expected outcome, not a failure: exit code stays
    // 0 in every format.
    yield* emitOutcome(planForRender, { dryRun: false, declined: true });
    return;
  }

  // 12. Re-read and compare against the step-3 baseline — someone may have
  // edited the file while the prompt was on screen.
  const currentText = yield* fs.readFileString(loaded.path).pipe(
    Effect.catchTag(
      "PlatformError",
      () =>
        new LegacyConfigPullFileChangedError({
          message: `${context.configPath} changed on disk while config pull was running; rerun the command to pick up the current file.`,
        }),
    ),
  );
  if (currentText !== input.originalText) {
    return yield* new LegacyConfigPullFileChangedError({
      message: `${context.configPath} changed on disk while config pull was running; rerun the command to pick up the current file.`,
    });
  }

  // 13. Apply and write. When this pull CREATES a new `[remotes.<label>]`
  // block (`planForRender.createdTable`), the block's own `project_id` is
  // NOT itself a `ConfigChange` (it is infrastructure for the block's
  // identity, never a comparable project-config path), so it never reaches
  // `plan.writes`/the payload — but it still has to be written, or the block
  // has no `project_id` for `remoteNameForProjectRef` to match on a future
  // run (this pull's own scope-resolution rule, `pull.scope.ts`).
  // `applyConfigEdits` only recognizes its "always EOF, project_id first"
  // `[remotes.*]` placement rule when an edit targets the label root
  // directly, so this must be its own edit, not folded into an existing one.
  const edits: ReadonlyArray<ConfigEdit> = [
    ...planForRender.writes.map((write) => ({ path: write.documentPath, value: write.value })),
    ...(planForRender.createdTable === undefined
      ? []
      : [{ path: [...planForRender.createdTable, "project_id"], value: ref }]),
  ];
  const editOutcome = applyConfigEdits(currentText, loaded.format, edits);
  if (editOutcome.kind === "refused") {
    return yield* new LegacyConfigPullUnsupportedLayoutError({
      message: `cannot write ${context.configPath}: ${editOutcome.refusal.reason} at ${legacyConfigRenderPath(editOutcome.refusal.path)} — ${editOutcome.refusal.detail}`,
    });
  }
  yield* writeCliConfigDocumentText(loaded.path, editOutcome.text).pipe(
    Effect.catchTag(
      "CliConfigWriteError",
      (cause) => new LegacyConfigPullWriteError({ message: cause.message }),
    ),
  );

  // 14. Final summary/payload.
  yield* emitOutcome(planForRender, { dryRun: false, declined: false });
});

/**
 * `legacyConfigPull` — the command-facing entry point (steps 1-4): rejects
 * `-o/--output`, loads/validates the local config and snapshots its on-disk
 * text BEFORE any network call or target resolution, resolves the target,
 * then delegates to {@link legacyRunConfigPull} for the rest.
 */
export const legacyConfigPull = Effect.fn("legacy.config.pull")(function* (
  flags: LegacyConfigPullFlags,
) {
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const goOutputFlag = yield* LegacyOutputFlag;
  const yes = yield* legacyResolveYes;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const { loadLocalConfig } = makeConfigLoader(cliSettings);

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
      return yield* new LegacyConfigPullOutputFlagUnsupportedError({
        message:
          "the -o/--output flag is not supported by config pull; use --output-format json|stream-json instead.",
      });
    }

    // 2. Load and validate the local config BEFORE any network call or
    // target resolution — a missing file must point at `supabase init`
    // rather than the resolver's not-linked error, and a malformed document
    // must not burn a branch-resolution round trip. No `[remotes.*]` overlay
    // yet: the overlay is keyed by the RESOLVED target ref, applied inside
    // `legacyRunConfigPull` (step 6) only when block reuse selects it.
    const baseLoaded = yield* loadLocalConfig(undefined);

    // 3. Read the file's exact on-disk text ONCE — the same bytes
    // `applyConfigEdits` edits later (step 13), and the baseline
    // `legacyRunConfigPull` re-reads before writing to detect a concurrent
    // edit (step 12).
    const originalText = yield* fs.readFileString(baseLoaded.path).pipe(
      Effect.catchTag(
        "PlatformError",
        (cause) =>
          new LegacyConfigPullLoadConfigError({
            message: `failed to read ${baseLoaded.path}: ${cause.message}`,
          }),
      ),
    );

    // 4. Resolve the pull target — hoisted into `legacyResolveConfigTarget`
    // (`../config.target.ts`, shared with `config diff`, CLI-2064).
    const { ref, branch } = yield* legacyResolveConfigTarget(requested, configTargetErrors);
    resolvedRef = ref;

    yield* legacyRunConfigPull({
      target: { ref, branch },
      remoteLabel,
      dryRun: flags.dryRun,
      force: flags.force,
      yes,
      baseLoaded,
      originalText,
    });
  }).pipe(
    // Legacy Shell Invariant #1: telemetry flushes on EVERY invocation —
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
