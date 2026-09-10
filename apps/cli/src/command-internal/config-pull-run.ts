import {
  CLI_CONFIG_SCHEMA_URL,
  diffProjectConfig,
  fromApiProjectConfig,
  type CliConfigParseError,
  type ConfigChangeSet,
  type ConfigFormat,
  type LoadedCliConfig,
} from "@supabase/config/effect";
import {
  applyConfigEdits,
  decodeCliConfigDocumentForValidationEffect,
  writeCliConfigDocumentText,
  type ConfigEdit,
  type ConfigEditRefusalReason,
  type DecodeCliConfigDocumentForValidationEffectOptions,
} from "@supabase/config/internal";
import type { ConfigChange } from "@supabase/config";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Result, Schema, SchemaIssue } from "effect";

import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { sanitizeErrorBody, sanitizeInlineName } from "./http-errors.ts";
import type { ConfigTarget } from "./project-target.ts";
import { BRANCH_UUID_PATTERN } from "./ref-patterns.ts";
import {
  configDeepSetAtPath,
  configIsRecord,
  configPathKey,
} from "../commands/config/config.paths.ts";
import { loadLocalConfig, relativeConfigPath } from "../commands/config/config.load.ts";
import {
  CONFIG_CLASS_LABELS,
  configApiScope,
  configChangePayloadEntry,
  configMaskedCaveat,
  configNotReturnedCaveat,
  configPlural,
  configRenderPath,
  configRenderValue,
  configScopeLine,
  configUnmanagedCaveat,
  type ConfigApiScope,
} from "../commands/config/config.format.ts";
import { configProjectConfigTry } from "../commands/config/config.project-config.ts";
import { configReadStatusMessage } from "../commands/config/config.read-status.ts";
import {
  configPullCreatedBlockLabel,
  configPullDestinationLine,
} from "../commands/config/pull/pull.format.ts";
import {
  configPullEnvVariableAtPath,
  configPullFamilyRootForPath,
  dropConfigPullUnvalidatableFamilies,
  expandConfigPullChangeSet,
  planConfigPull,
  type ConfigPullMissingField,
  type ConfigPullPlan,
  type ConfigPullSkipReason,
  type ConfigPullWarning,
  type ConfigPullWouldInvalidateFamily,
} from "../commands/config/pull/pull.plan.ts";
import {
  resolveConfigPullDestination,
  type ConfigPullDestination,
  type ConfigPullScopeLabelCollision,
} from "../commands/config/pull/pull.scope.ts";
import {
  ConfigPullFileChangedError,
  ConfigPullLoadConfigError,
  ConfigPullPlanDefectError,
  ConfigPullReadNetworkError,
  ConfigPullReadStatusError,
  ConfigPullRemoteEnvRefError,
  ConfigPullRemoteLabelCollisionError,
  ConfigPullUnsupportedLayoutError,
  ConfigPullValidationFailedError,
  ConfigPullWriteError,
} from "../commands/config/pull/pull.errors.ts";

/**
 * `config pull`'s plan/apply core, hoisted out of `commands/config/pull/` so
 * `commands/pull/` can reuse the same plan/apply/formatting logic without importing
 * another command's internals. `pull.handler.ts` still owns the CLI entry point;
 * `pull.format.ts` re-exports the payload/render pieces that moved here.
 */

export interface ConfigPullPlanRequest {
  readonly target: ConfigTarget;
  readonly remoteLabel: string | undefined;
  readonly source: ConfigPullSource;
}

export interface ConfigPullRunPlan {
  readonly changeSet: ConfigChangeSet;
  readonly scope: ConfigApiScope;
  readonly plan: ConfigPullPlan;
  readonly context: ConfigPullContext;
  /** Absolute path of the file the writes target (`loaded.path`) — subject of the git guard and the TOCTOU re-read. */
  readonly configFilePath: string;
  /** `plan.writes.length > 0 || plan.createdTable !== undefined`. */
  readonly hasWork: boolean;
}

/**
 * The run's actual outcome, known only after the confirmation prompt (or `--dry-run`)
 * resolves — layered on top of {@link ConfigPullPlan}, which only knows what would be
 * written. `dryRun` and `declined` are mutually exclusive: a `--dry-run` run never reaches
 * the prompt.
 */
export interface ConfigPullOutcome {
  readonly dryRun: boolean;
  /** The confirmation prompt was declined — every planned write becomes
   * `skipped_reason: "declined"` instead of being applied. */
  readonly declined: boolean;
}

export interface ConfigPullContext {
  /** The resolved target's project ref. */
  readonly projectRef: string;
  /** The branch name or UUID `--project-ref` carried, when it named one. */
  readonly branch: string | undefined;
  /** The local file's `$schema` ref (or the current schema URL). */
  readonly configSchema: string;
  /** The config file path, rendered relative like the rest of the family
   * (`supabase/config.toml`). */
  readonly configPath: string;
  readonly format: ConfigFormat;
  /** Matched `[remotes.<name>]` block the diff operand was merged from — independent of
   * `destination` (a brand-new `[remotes.*]` block being created has no applied overlay to
   * diff against yet). Mirrors `config diff`'s own `target.local_scope`. */
  readonly appliedRemote: string | undefined;
  readonly destination: ConfigPullDestination;
}

/**
 * Version of the payload shape below; bump when the contract changes incompatibly.
 * Independent of `config diff`'s `CONFIG_DIFF_PAYLOAD_VERSION`.
 */
export const CONFIG_PULL_PAYLOAD_VERSION = 1;

/**
 * A change's actual disposition once the confirmation prompt (and `--dry-run`) are known —
 * broader than {@link ConfigPullSkipReason} (the pure planning-time reason a change was never
 * even attempted): a change `planConfigPull` planned to write still ends up unwritten when
 * the run is a dry run or the user declined.
 */
type ConfigPullChangeSkipReason = ConfigPullSkipReason | "declined" | "dry_run";

/**
 * The collision message (`ConfigPullRemoteLabelCollisionError`), worded differently
 * depending on which of `pull.scope.ts`'s two `label_collision` situations applies and
 * whether the label came from an explicit `--remote-label` or a branch name (only
 * `--remote-label` can reach the "a different block already tracks this ref" situation — see
 * `resolveConfigPullDestination`'s own doc comment for why a branch-derived label never does).
 */
function configPullLabelCollisionMessage(
  scopeResult: ConfigPullScopeLabelCollision,
  fromRemoteLabelFlag: boolean,
): string {
  const label = sanitizeInlineName(scopeResult.label);
  const conflictingProjectId = sanitizeInlineName(scopeResult.conflictingProjectId);
  const conflictingBlock = sanitizeInlineName(scopeResult.conflictingBlock);
  if (!fromRemoteLabelFlag) {
    return `branch "${label}" would create [remotes.${label}], but that block already tracks project ${conflictingProjectId}; pass --remote-label to write under a different name, or rename/remove the existing block first.`;
  }
  if (conflictingBlock !== label) {
    return `[remotes.${conflictingBlock}] already tracks project ${conflictingProjectId}. Drop --remote-label to write there, or rename that block first.`;
  }
  return `--remote-label "${label}" already tracks project ${conflictingProjectId}; pass a different --remote-label, or drop the flag to reuse the block that already tracks this project.`;
}

/**
 * Human-readable phrase for a `ConfigEditRefusal.reason` — the raw enum
 * token (`duplicate_table_header`, ...) never appears in the constructed
 * `ConfigPullUnsupportedLayoutError` message, only prose.
 */
function configPullRefusalPhrase(reason: ConfigEditRefusalReason): string {
  switch (reason) {
    case "duplicate_table_header":
      return "a duplicate table header";
    case "array_of_tables_on_path":
      return "an array of tables on this path";
    case "inline_table_on_path":
      return "an inline table on this path";
    case "env_reference_target":
      return "an existing env() reference at this path";
    case "verification_mismatch":
      return "a verification mismatch after editing";
    case "parse_error":
      return "a parse error";
  }
}

/**
 * One remediation sentence per `ConfigEditRefusal.reason` — `env_reference_target`
 * stays generic (the planner already skips every `env()`-declared change
 * before it ever reaches `applyConfigEdits`, so this reason should not occur
 * in practice); `verification_mismatch`/`parse_error` both mean the editor
 * itself misjudged the document, not something the user can fix by hand.
 */
function configPullRefusalRemediation(reason: ConfigEditRefusalReason): string {
  switch (reason) {
    case "duplicate_table_header":
      return "Merge the duplicate table headers into one, then rerun.";
    case "inline_table_on_path":
      return "Rewrite it as a standard [table] section, then rerun.";
    case "array_of_tables_on_path":
      return "config pull does not support writing through an array of tables ([[...]]); restructure it by hand, then rerun.";
    case "env_reference_target":
      return "Replace the env(...) reference with a literal value, then rerun.";
    case "verification_mismatch":
    case "parse_error":
      return "This is a CLI bug; nothing was written. Please report it.";
  }
}

/**
 * Convergence check run after the fixpoint expansion settles, before `--dry-run` returns,
 * against the fixpoint's own residual (the last round's re-diff). A residual change at a
 * path this run just planned to write means the write didn't converge — a planner defect,
 * surfaced as `ConfigPullPlanDefectError` rather than a crash, since nothing has been written
 * yet. A residual `unmanaged` path instead means the value this run just wrote made itself
 * invisible to the projection again; that's a known, if rare, side effect of a cross-path
 * config prune (see `applyDisabledSentinels`'s cross-section rule in `project-config.ts`), so
 * it's surfaced as an `"unpushable"` warning through the same `plan.warnings` hook rather than
 * treated as a defect.
 */
function configPullDefectAndUnpushableCheck(
  plan: ConfigPullPlan,
  residual: ConfigChangeSet,
): Effect.Effect<ConfigPullPlan, ConfigPullPlanDefectError> {
  if (plan.writes.length === 0) {
    return Effect.succeed(plan);
  }
  const writtenPathKeys = new Set(plan.writes.map((write) => configPathKey(write.change.path)));
  const stillDrifting = residual.changes.filter((change) =>
    writtenPathKeys.has(configPathKey(change.path)),
  );
  if (stillDrifting.length > 0) {
    return new ConfigPullPlanDefectError({
      message: `config pull planner defect: ${stillDrifting
        .map((change) => configRenderPath(change.path))
        .join(
          ", ",
        )} still differ from remote after applying the planned write; nothing was written. Please report this bug.`,
    });
  }

  const unpushableWarnings: ReadonlyArray<ConfigPullWarning> = residual.unmanaged
    .filter((path) => writtenPathKeys.has(configPathKey(path)))
    .map((path) => ({ kind: "unpushable", path }));

  return Effect.succeed(
    unpushableWarnings.length === 0
      ? plan
      : { ...plan, warnings: [...plan.warnings, ...unpushableWarnings] },
  );
}

/**
 * Builds the raw, on-disk-shaped document the schema-validation gate decodes:
 * `rawDocument` with the planned `writes`' `documentPath`s applied, plus the new block's
 * `project_id` when this plan creates one — so validation runs against what would actually
 * be written.
 */
function configPullValidationDocument(
  rawDocument: Readonly<Record<string, unknown>>,
  writes: ReadonlyArray<ConfigPullPlan["writes"][number]>,
  createdTable: ReadonlyArray<string> | undefined,
  projectRef: string,
): Record<string, unknown> {
  const withWrites = writes.reduce(
    (document, write) => configDeepSetAtPath(document, write.documentPath, write.value),
    rawDocument,
  );
  return createdTable === undefined
    ? withWrites
    : configDeepSetAtPath(withWrites, [...createdTable, "project_id"], projectRef);
}

/**
 * Restricts a document to the subtree a `ConfigChange.path` is relative to: itself for a
 * root destination, or `document.remotes[label]` for a `[remotes.*]` destination. The
 * inverse of `documentPathFor` (`pull.plan.ts`).
 */
function configPullChangeRelativeValue(
  document: unknown,
  destination: ConfigPullDestination,
): unknown {
  if (destination.kind === "root") {
    return document;
  }
  const remotes = configIsRecord(document) ? document["remotes"] : undefined;
  return configIsRecord(remotes) ? remotes[destination.label] : undefined;
}

/**
 * Converts a failed {@link decodeCliConfigDocumentForValidationEffect} attempt's
 * `SchemaIssue` paths into `ConfigChange.path`-relative segments. `isLabelPrefixed` strips
 * one leading segment for the raw/unmerged projection of a remote destination, whose issue
 * paths start with the `remotes` map's own key (the label) rather than already being
 * change-path-relative like every other case. Returns no paths for a non-`SchemaError`
 * cause, which callers treat as "could not attribute this failure".
 */
function configPullSchemaIssueChangePaths(
  cause: CliConfigParseError,
  isLabelPrefixed: boolean,
): ReadonlyArray<ReadonlyArray<string>> {
  if (!Schema.isSchemaError(cause.cause)) {
    return [];
  }
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(cause.cause.issue);
  const changePaths: Array<ReadonlyArray<string>> = [];
  for (const issue of issues) {
    const rawPath = issue.path?.map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    );
    if (rawPath === undefined || rawPath.length === 0) {
      continue;
    }
    const changePath = isLabelPrefixed ? rawPath.slice(1) : rawPath;
    if (changePath.length === 0) {
      continue;
    }
    changePaths.push(changePath);
  }
  return changePaths;
}

/**
 * Groups already-resolved change-paths (already filtered by the caller to exclude every
 * pre-existing failure) by `configPullFamilyRootForPath`'s nearest-enclosing-table rule,
 * enriching each with its local `env(VAR)` spelling when it has one. `relativeValidation`/
 * `relativeRaw` are always the destination-relative view
 * ({@link configPullChangeRelativeValue}), regardless of which projection reported the
 * failure.
 */
function configPullFamiliesForChangePaths(
  changePaths: ReadonlyArray<ReadonlyArray<string>>,
  relativeValidation: unknown,
  relativeRaw: unknown,
): ReadonlyArray<ConfigPullWouldInvalidateFamily> {
  const families = new Map<
    string,
    { root: ReadonlyArray<string>; missingFields: Map<string, ConfigPullMissingField> }
  >();
  for (const changePath of changePaths) {
    const root = configPullFamilyRootForPath(changePath, relativeValidation);
    const key = configPathKey(root);
    const envVariable = configPullEnvVariableAtPath(changePath, relativeRaw);
    const field: ConfigPullMissingField = {
      path: changePath,
      ...(envVariable === undefined ? {} : { envVariable }),
    };
    const existing = families.get(key);
    if (existing === undefined) {
      families.set(key, {
        root,
        missingFields: new Map([[configPathKey(changePath), field]]),
      });
    } else {
      existing.missingFields.set(configPathKey(changePath), field);
    }
  }
  return [...families.values()].map((family) => ({
    root: family.root,
    missingFields: [...family.missingFields.values()],
  }));
}

/**
 * Runs {@link decodeCliConfigDocumentForValidationEffect}, capturing only its own
 * `CliConfigParseError` failure into a `Result`. A genuinely malformed `.env`/`.env.local`,
 * or a filesystem failure reading one, is not a decode-attribution failure, so those
 * propagate uncaught, matching how the real `loadCliConfig` call already handles them.
 */
function decodeConfigPullValidation(
  document: Record<string, unknown>,
  options: DecodeCliConfigDocumentForValidationEffectOptions,
) {
  return decodeCliConfigDocumentForValidationEffect(document, options).pipe(
    Effect.map(Result.succeed),
    Effect.catchTag("CliConfigParseError", (cause) => Effect.succeed(Result.fail(cause))),
  );
}

/**
 * The change-path keys ({@link configPathKey}) that already fail
 * {@link decodeCliConfigDocumentForValidationEffect} in `rawDocument` as it sits on disk
 * right now, before this pull's own writes are projected. {@link validateConfigPullPlan}
 * excludes these from the families it forms — pulling should never attribute, drop, or fail
 * over a pre-existing problem; it only needs to leave the file no worse than it was. Runs
 * both projections (raw, plus `remoteName`-merged for a remote destination) so a failure
 * that only surfaces once a `[remotes.*]` block is selected is exempted too.
 */
const configPullPreExistingFailingChangePathKeys = Effect.fnUntraced(function* (input: {
  readonly rawDocument: Readonly<Record<string, unknown>>;
  readonly destination: ConfigPullDestination;
  readonly configPath: string;
  readonly format: ConfigFormat;
}) {
  const keys = new Set<string>();
  const rawDecoded = yield* decodeConfigPullValidation(input.rawDocument, {
    path: input.configPath,
    format: input.format,
    goViperCompat: true,
  });
  if (Result.isFailure(rawDecoded)) {
    for (const path of configPullSchemaIssueChangePaths(
      rawDecoded.failure,
      input.destination.kind === "remote",
    )) {
      keys.add(configPathKey(path));
    }
  }
  if (input.destination.kind === "remote") {
    const mergedDecoded = yield* decodeConfigPullValidation(input.rawDocument, {
      path: input.configPath,
      format: input.format,
      goViperCompat: true,
      remoteName: input.destination.label,
    });
    if (Result.isFailure(mergedDecoded)) {
      for (const path of configPullSchemaIssueChangePaths(mergedDecoded.failure, false)) {
        keys.add(configPathKey(path));
      }
    }
  }
  return keys;
});

/** Cap on how many times {@link validateConfigPullPlan} drops a family and re-validates;
 * hitting it fails the command with `ConfigPullValidationFailedError` rather than writing. */
const CONFIG_PULL_VALIDATION_ROUND_CAP = 4;

/**
 * `config pull`'s schema-validation gate: decodes the projected final document the way the
 * next `loadCliConfig` call will (including a `[remotes.*]` destination's `remoteName`-merged
 * projection, since a block can pass the raw check yet still fail once selected), and never
 * writes a file the CLI itself couldn't load. A failure already present in
 * {@link configPullPreExistingFailingChangePathKeys} is ignored; a new one drops its
 * enclosing family ({@link dropConfigPullUnvalidatableFamilies}) and retries, up to
 * {@link CONFIG_PULL_VALIDATION_ROUND_CAP} times, else fails the command
 * (`ConfigPullValidationFailedError`) instead of writing.
 */
const validateConfigPullPlan = Effect.fnUntraced(function* (input: {
  readonly plan: ConfigPullPlan;
  readonly rawDocument: Readonly<Record<string, unknown>>;
  readonly destination: ConfigPullDestination;
  readonly projectRef: string;
  readonly configPath: string;
  readonly format: ConfigFormat;
}) {
  const destination = input.destination;
  const preExisting = yield* configPullPreExistingFailingChangePathKeys({
    rawDocument: input.rawDocument,
    destination,
    configPath: input.configPath,
    format: input.format,
  });

  let plan = input.plan;
  for (let round = 0; ; round++) {
    const document = configPullValidationDocument(
      input.rawDocument,
      plan.writes,
      plan.createdTable,
      input.projectRef,
    );
    const rawDecoded = yield* decodeConfigPullValidation(document, {
      goViperCompat: true,
      path: input.configPath,
      format: input.format,
    });
    const mergedDecoded =
      destination.kind === "remote"
        ? yield* decodeConfigPullValidation(document, {
            goViperCompat: true,
            path: input.configPath,
            format: input.format,
            remoteName: destination.label,
          })
        : undefined;

    if (
      Result.isSuccess(rawDecoded) &&
      (mergedDecoded === undefined || Result.isSuccess(mergedDecoded))
    ) {
      return plan;
    }

    const rawChangePaths = Result.isFailure(rawDecoded)
      ? configPullSchemaIssueChangePaths(rawDecoded.failure, destination.kind === "remote")
      : [];
    const mergedChangePaths =
      mergedDecoded !== undefined && Result.isFailure(mergedDecoded)
        ? configPullSchemaIssueChangePaths(mergedDecoded.failure, false)
        : [];
    const allChangePaths = [...rawChangePaths, ...mergedChangePaths];
    const newChangePaths = allChangePaths.filter((path) => !preExisting.has(configPathKey(path)));

    if (allChangePaths.length > 0 && newChangePaths.length === 0) {
      // Every attributable failure traces back to a problem that already
      // existed before this run touched the file — accept the plan as-is
      // rather than drop or fail over it (see
      // `configPullPreExistingFailingChangePathKeys`'s doc comment).
      return plan;
    }

    if (round >= CONFIG_PULL_VALIDATION_ROUND_CAP) {
      break;
    }
    const relativeValidation = configPullChangeRelativeValue(document, destination);
    const relativeRaw = configPullChangeRelativeValue(input.rawDocument, destination);
    const families = configPullFamiliesForChangePaths(
      newChangePaths,
      relativeValidation,
      relativeRaw,
    );
    const next = dropConfigPullUnvalidatableFamilies(plan, families);
    if (next.writes.length === plan.writes.length) {
      // Nothing could be dropped for the reported failure(s) — retrying
      // would just repeat the same decode failure forever.
      break;
    }
    plan = next;
  }
  return yield* new ConfigPullValidationFailedError({
    message: `config pull's planned writes would still leave ${input.configPath} unloadable after dropping every family the validator flagged; nothing was written. Please report this bug.`,
  });
});

/** Builds the file-load helpers for one `cliSettings.workdir`, narrowed to `workdir` and
 * `explicitWorkdir` since that's all `loadLocalConfig` needs; only this family's own tagged
 * error class is local. */
function makeConfigLoader(cliSettings: {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}) {
  const toRelativeConfigPath = (path: string): string =>
    relativeConfigPath(cliSettings.workdir, path);

  const loadConfig = (projectRef: string | undefined) =>
    loadLocalConfig(
      cliSettings,
      projectRef,
      (message) => new ConfigPullLoadConfigError({ message }),
    );

  return { toRelativeConfigPath, loadConfig };
}

/**
 * The paired base config load and its exact on-disk text, produced only by
 * {@link openConfigPullSource} so both properties — no `[remotes.*]` overlay, and text read
 * from the same path right after the load — hold by construction, not caller convention.
 */
export interface ConfigPullSource {
  readonly loaded: LoadedCliConfig;
  readonly text: string;
}

/**
 * Opens `config pull`'s base config source: loads the local config with no `[remotes.*]`
 * overlay (applied later, only when block reuse selects an existing block), then uses
 * `loaded.rawText` as this pull's baseline text instead of reading the file again — a second
 * read would reopen a window for a concurrent edit to land between the parsed load and that
 * read, silently becoming the accepted baseline while the plan below is computed against the
 * now-stale parsed values.
 */
export const openConfigPullSource = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const { loadConfig, toRelativeConfigPath } = makeConfigLoader(cliSettings);

  const loaded = yield* loadConfig(undefined);

  if (loaded.rawText === undefined) {
    // The loader guarantees `rawText` for any file it parsed off disk; treat this like a
    // concurrent edit rather than re-reading, which would reopen the race this baseline
    // exists to close.
    return yield* new ConfigPullFileChangedError({
      message: `${toRelativeConfigPath(loaded.path)} could not be read: the config loader returned no on-disk text. Rerun the command.`,
    });
  }

  return { loaded, text: loaded.rawText };
});

/**
 * Resolves the pull destination, reloads with the `[remotes.*]` overlay when block reuse
 * selects an existing block, fetches the remote config, and runs the fixpoint-expanded
 * diff/plan plus the planner-defect/schema-validation gate. Prints the destination and
 * comparison-scope lines to stderr exactly once. Never runs the git dirty guard, prompts,
 * writes, or calls `output.success`; the caller decides what to do with the returned
 * {@link ConfigPullRunPlan}.
 */
export const planConfigPullRun = Effect.fnUntraced(function* (request: ConfigPullPlanRequest) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const { ref, branch } = request.target;
  const { loadConfig, toRelativeConfigPath } = makeConfigLoader(cliSettings);

  const branchLabelCandidate =
    branch !== undefined && !BRANCH_UUID_PATTERN.test(branch) ? branch : undefined;
  const scopeResult = resolveConfigPullDestination({
    rawRemotes: request.source.loaded.rawDocument?.["remotes"],
    interpolatedRemotes: request.source.loaded.interpolatedRemotes,
    projectRef: ref,
    branchLabelCandidate,
    targetWasBranch: branch !== undefined,
    requestedLabel: request.remoteLabel,
  });
  if (!scopeResult.ok) {
    if (scopeResult.reason === "label_collision") {
      return yield* new ConfigPullRemoteLabelCollisionError({
        message: configPullLabelCollisionMessage(scopeResult, request.remoteLabel !== undefined),
      });
    }
    return yield* new ConfigPullRemoteEnvRefError({
      message: `[remotes.${sanitizeInlineName(scopeResult.label)}].project_id is spelled as env(${scopeResult.envVariables.map((name) => sanitizeInlineName(name)).join(", ")}), but the config loader matches project_id literally — this block has never applied to any project (supabase start and config push have both been ignoring it). Replace it with the literal ref ${sanitizeInlineName(ref)} to make the block real, or pass --remote-label <name> to write a new block instead.`,
    });
  }
  const destination = scopeResult.destination;
  yield* output.raw(configPullDestinationLine({ projectRef: ref, branch }, destination), "stderr");

  // A brand-new block has nothing to overlay yet.
  let loaded = request.source.loaded;
  if (destination.kind === "remote" && !destination.created) {
    loaded = yield* loadConfig(ref);
  }

  const context: ConfigPullContext = {
    projectRef: ref,
    branch,
    configSchema: loaded.schemaRef ?? CLI_CONFIG_SCHEMA_URL,
    configPath: toRelativeConfigPath(loaded.path),
    format: loaded.format,
    appliedRemote: loaded.appliedRemote,
    destination,
  };

  // See ADR 0019 rule 2: `executeRaw` + lenient decode; the caller owns the status check,
  // `fromApiProjectConfig`'s lenient decode owns the body.
  const fetching =
    output.format === "text" ? yield* output.task("Fetching remote config...") : undefined;
  const response = yield* api.executeRaw(operationDefinitions.v2GetProjectConfig, { ref }).pipe(
    Effect.tapError(() => fetching?.fail() ?? Effect.void),
    Effect.mapError(
      (cause) =>
        new ConfigPullReadNetworkError({
          message: `failed to read project config: ${cause}`,
        }),
    ),
  );
  if (response.status !== 200) {
    const body = sanitizeErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
    yield* fetching?.fail() ?? Effect.void;
    return yield* new ConfigPullReadStatusError({
      status: response.status,
      body,
      message: configReadStatusMessage(response.status, body, ref, cliSettings.apiUrl),
    });
  }
  const responseJson = yield* response.json.pipe(
    Effect.tapError(() => fetching?.fail() ?? Effect.void),
    Effect.mapError(
      (cause) =>
        new ConfigPullReadNetworkError({
          message: `failed to read project config: ${cause}`,
          decode: true,
        }),
    ),
  );
  yield* fetching?.clear() ?? Effect.void;

  // Normalizes and classifies the response through the config family's shared
  // typed/defect boundary (ADR 0021).
  const remote = yield* configProjectConfigTry(() => fromApiProjectConfig(responseJson));
  const initialChangeSet = yield* configProjectConfigTry(() =>
    diffProjectConfig({ local: loaded, remote }),
  );

  const data = configIsRecord(responseJson) ? responseJson["data"] : undefined;
  const scope = configApiScope(
    configIsRecord(data) && configIsRecord(data["attributes"]) ? data["attributes"] : {},
  );
  yield* output.raw(configScopeLine(scope), "stderr");

  // Projecting a round's writes can un-gate sibling fields ADR 0021 otherwise excludes as
  // unmanaged (e.g. flipping a disabled SMS provider's `enabled` on un-gates its credential
  // fields), so `expandConfigPullChangeSet` repeats until nothing new appears.
  const fixpoint = yield* configProjectConfigTry(() =>
    expandConfigPullChangeSet({
      initialChangeSet,
      baseConfig: loaded.config,
      baseDocument: loaded.document ?? {},
      valueOrigins: loaded.valueOrigins,
      remote,
    }),
  );
  const changeSet = fixpoint.changeSet;
  const plan = planConfigPull({
    changeSet,
    destination,
    rootDocument: request.source.loaded.document ?? {},
    projectRef: ref,
  });
  const planWithDefectCheck = yield* configPullDefectAndUnpushableCheck(plan, fixpoint.residual);
  const finalPlan = yield* validateConfigPullPlan({
    plan: planWithDefectCheck,
    rawDocument: request.source.loaded.rawDocument ?? {},
    destination,
    projectRef: ref,
    configPath: loaded.path,
    format: loaded.format,
  });

  // A zero-drift branch target can still have work to do — creating the block — so it must
  // reach the git guard/confirmation like any other write.
  const hasBlockToCreate = finalPlan.createdTable !== undefined;
  const hasWork = finalPlan.writes.length > 0 || hasBlockToCreate;

  return {
    changeSet,
    scope,
    plan: finalPlan,
    context,
    configFilePath: loaded.path,
    hasWork,
  } satisfies ConfigPullRunPlan;
});

/**
 * The TOCTOU re-read against {@link ConfigPullSource.text} (someone may have edited the file
 * while the confirmation prompt was on screen), `applyConfigEdits`, and the atomic write. No
 * emission — the caller renders the final summary/payload once this succeeds.
 */
export const applyConfigPullRun = Effect.fnUntraced(function* (input: {
  readonly runPlan: ConfigPullRunPlan;
  readonly source: ConfigPullSource;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { plan, context, configFilePath } = input.runPlan;

  const currentText = yield* fs.readFileString(configFilePath).pipe(
    Effect.catchTag(
      "PlatformError",
      () =>
        new ConfigPullFileChangedError({
          message: `${context.configPath} changed on disk while config pull was running; rerun the command to pick up the current file.`,
        }),
    ),
  );
  if (currentText !== input.source.text) {
    return yield* new ConfigPullFileChangedError({
      message: `${context.configPath} changed on disk while config pull was running; rerun the command to pick up the current file.`,
    });
  }

  // When this pull creates a new `[remotes.<label>]` block, its `project_id` isn't itself a
  // `ConfigChange` (infrastructure, not a comparable path), so it never reaches `plan.writes`,
  // but it must still be written for `remoteNameForProjectRef` to match on a future run.
  // `applyConfigEdits`'s EOF/project-id-first placement rule only applies when an edit targets
  // the label root directly, so this must be its own edit.
  const edits: ReadonlyArray<ConfigEdit> = [
    ...plan.writes.map((write) => ({ path: write.documentPath, value: write.value })),
    ...(plan.createdTable === undefined
      ? []
      : [{ path: [...plan.createdTable, "project_id"], value: context.projectRef }]),
  ];
  const editOutcome = applyConfigEdits(currentText, context.format, edits);
  if (editOutcome.kind === "refused") {
    const { reason, path, detail } = editOutcome.refusal;
    const location = path.length === 0 ? "" : ` at ${configRenderPath(path)}`;
    return yield* new ConfigPullUnsupportedLayoutError({
      message: `cannot write ${context.configPath}: ${configPullRefusalPhrase(reason)}${location} — ${detail}. ${configPullRefusalRemediation(reason)}`,
    });
  }
  yield* writeCliConfigDocumentText(configFilePath, editOutcome.text).pipe(
    Effect.catchTag(
      "CliConfigWriteError",
      (cause) => new ConfigPullWriteError({ message: cause.message }),
    ),
  );
});

interface ChangeStatus {
  readonly written: boolean;
  readonly reason?: ConfigPullChangeSkipReason;
}

/**
 * Every `changeSet.changes` entry's actual disposition: `plan.writes` unless
 * the run outcome turns a planned write into a skip (`dryRun`/`declined`),
 * else `plan.skipped`'s own planning-time reason.
 */
function buildChangeStatus(
  plan: ConfigPullPlan,
  outcome: ConfigPullOutcome,
): ReadonlyMap<string, ChangeStatus> {
  const status = new Map<string, ChangeStatus>();
  const writeSkipReason: ConfigPullChangeSkipReason | undefined = outcome.dryRun
    ? "dry_run"
    : outcome.declined
      ? "declined"
      : undefined;
  for (const write of plan.writes) {
    status.set(
      configPathKey(write.change.path),
      writeSkipReason === undefined
        ? { written: true }
        : { written: false, reason: writeSkipReason },
    );
  }
  for (const skip of plan.skipped) {
    status.set(configPathKey(skip.change.path), { written: false, reason: skip.reason });
  }
  return status;
}

function writtenCount(plan: ConfigPullPlan, outcome: ConfigPullOutcome): number {
  return outcome.dryRun || outcome.declined ? 0 : plan.writes.length;
}

function renderLocal(local: unknown, declared: boolean): string {
  const value = configRenderValue(local, "(unset)");
  return local !== undefined && !declared
    ? `${value} (schema default — not declared in config.toml)`
    : value;
}

function warningMessage(warning: ConfigPullWarning, configPath: string): string {
  const path = warning.path === undefined ? undefined : configRenderPath(warning.path);
  switch (warning.kind) {
    case "dual_scope":
      return `${path} also configures the local stack (\`supabase start\`) — writing it to the config root changes local dev behavior too.`;
    case "duplicates_root":
      return `${path} already matches the config root's value — this remote block now carries a redundant copy.`;
    case "array_drift":
      return `${path} is an array also declared at the config root — the two copies will not stay in sync.`;
    case "uncommitted_changes":
      return `${configPath} has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.`;
    case "unpushable":
      return `${path} was written here, but \`config push\` cannot send it back to the platform — it will keep showing as out of sync.`;
    case "would_invalidate": {
      const fields = warning.missingFields ?? [];
      const fieldNames = fields.map((field) => configRenderPath(field.path));
      const envVariables = fields
        .map((field) => field.envVariable)
        .filter((name): name is string => name !== undefined)
        .map((name) => sanitizeInlineName(name));
      const remedy =
        envVariables.length > 0
          ? `set ${envVariables.join(", ")} and rerun, or configure it manually`
          : "configure it manually";
      return `${path} was not changed: it requires ${fieldNames.join(", ")} — ${remedy}.`;
    }
  }
}

/**
 * Text-mode-only rewording of {@link ConfigPullSkipReason} for the
 * per-change marker (`renderConfigPullText`) — the machine payload's
 * own `skipped_reason` token (`configPullPayload`) is untouched.
 */
function humanizeSkipReason(reason: ConfigPullSkipReason): string {
  switch (reason) {
    case "env_reference":
      return "env() reference";
    case "remote_env_reference":
      return "remote value looks like env() — not written";
    case "unwritable":
      return "not representable";
    case "local_only":
      // Never actually reached: a `local_only` skip's own marker is built
      // directly (see `changeMarker` below), since the reason would only
      // restate the change's own class.
      return "local only";
    case "would_invalidate":
      return "requires values pull cannot write";
  }
}

/**
 * The per-change marker (`write`/`skip: ...`); suppresses the skip reason when it would
 * merely restate the change's own class (a `local_only` change is always skipped for that
 * same reason), and humanizes every other skip reason for text-mode prose.
 */
function changeMarker(
  change: ConfigChange,
  writePaths: ReadonlySet<string>,
  skipReasonByPath: ReadonlyMap<string, ConfigPullSkipReason>,
): string {
  if (writePaths.has(configPathKey(change.path))) {
    return "write";
  }
  const reason = skipReasonByPath.get(configPathKey(change.path));
  if (reason === undefined || reason === change.class) {
    return "not pulled";
  }
  return `skip: ${humanizeSkipReason(reason)}`;
}

/**
 * Human-readable change-by-change body for text mode, shown before the confirmation prompt
 * (and reused for `--dry-run`) — it reports what the plan would do, independent of the run's
 * eventual outcome. The final one-line disposition is {@link configPullSummaryMessage}'s job.
 *
 * A `plan.createdTable` always gets its own line naming the new block, even when no value
 * write is planned, so a block-only run states its action here too.
 */
export function renderConfigPullText(
  changeSet: ConfigChangeSet,
  scope: ConfigApiScope,
  plan: ConfigPullPlan,
  projectRef: string,
  configPath: string,
): string {
  const writePaths = new Set(plan.writes.map((write) => configPathKey(write.change.path)));
  const skipReasonByPath = new Map(
    plan.skipped.map((skip) => [configPathKey(skip.change.path), skip.reason] as const),
  );

  const lines: Array<string> = [];
  for (const change of changeSet.changes) {
    const marker = changeMarker(change, writePaths, skipReasonByPath);
    lines.push(
      `${configRenderPath(change.path)} [${CONFIG_CLASS_LABELS[change.class]}, ${marker}]`,
    );
    const env =
      change.envVariables === undefined
        ? ""
        : ` (from env ${sanitizeInlineName(change.envVariables.join(", "))})`;
    lines.push(`  local:  ${renderLocal(change.local, change.declared)}${env}`);
    lines.push(`  remote: ${configRenderValue(change.remote, "(not returned)")}`);
    lines.push("");
  }

  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  ${warningMessage(warning, configPath)}`);
    }
    lines.push("");
  }

  const total = changeSet.counts.total;
  if (total === 0) {
    lines.push("No config differences found.");
  } else {
    lines.push(
      `${configPlural(total, "difference", "differences")} found (${plan.writes.length} to write, ${plan.skipped.length} to skip).`,
    );
  }
  if (plan.createdTable !== undefined) {
    lines.push(
      `New block [remotes.${configPullCreatedBlockLabel(plan.createdTable)}] will be created (project_id = ${sanitizeInlineName(projectRef)}).`,
    );
  }
  if (scope.missing.length > 0) {
    lines.push(`Note: ${configNotReturnedCaveat(scope.missing)}`);
  }
  if (changeSet.masked.length > 0) {
    lines.push(`Note: ${configMaskedCaveat(changeSet.masked)}`);
  }
  if (changeSet.unmanaged.length > 0) {
    lines.push(`Note: ${configUnmanagedCaveat(changeSet.unmanaged)}`);
  }
  return `${lines.join("\n")}\n`;
}

function destinationPayload(destination: ConfigPullDestination): Record<string, unknown> {
  return destination.kind === "root"
    ? { scope: "base", created: false }
    : {
        scope: `remotes.${destination.label}`,
        label: destination.label,
        created: destination.created,
      };
}

/**
 * The structured result for `--output-format json|stream-json` — the only machine-output
 * mechanism this command honors (`-o`/`--output` is rejected outright). Unset sides are
 * explicit `null`s (via `configChangePayloadEntry`), distinguishable from empty values.
 */
export function configPullPayload(
  changeSet: ConfigChangeSet,
  scope: ConfigApiScope,
  plan: ConfigPullPlan,
  context: ConfigPullContext,
  outcome: ConfigPullOutcome,
): Record<string, unknown> {
  const status = buildChangeStatus(plan, outcome);
  const written = writtenCount(plan, outcome);
  const documentPathByKey = new Map(
    plan.writes.map((write) => [configPathKey(write.change.path), write.documentPath] as const),
  );
  // A block-only run still wrote the new block even though `written` (a count of value
  // writes) stays 0; `dryRun`/`declined` mean the block was never actually created.
  const wrote =
    written > 0 || (plan.createdTable !== undefined && !outcome.dryRun && !outcome.declined);

  return {
    schema_version: CONFIG_PULL_PAYLOAD_VERSION,
    config_schema: context.configSchema,
    config_path: context.configPath,
    format: context.format,
    target: {
      project_ref: context.projectRef,
      ...(context.branch === undefined ? {} : { branch: context.branch }),
      local_scope:
        context.appliedRemote === undefined ? "base" : `remotes.${context.appliedRemote}`,
    },
    destination: destinationPayload(context.destination),
    dry_run: outcome.dryRun,
    wrote,
    scope: { present: scope.present, missing: scope.missing },
    changes: changeSet.changes.map((change) => {
      const entry = status.get(configPathKey(change.path));
      const changeWritten = entry?.written ?? false;
      const documentPath = documentPathByKey.get(configPathKey(change.path));
      return {
        ...configChangePayloadEntry(change),
        written: changeWritten,
        ...(entry?.reason === undefined ? {} : { skipped_reason: entry.reason }),
        // Only an actually-written entry carries `document_path`; a dry-run/declined outcome
        // still has a planned path, but nothing landed there.
        ...(changeWritten && documentPath !== undefined ? { document_path: documentPath } : {}),
      };
    }),
    warnings: plan.warnings.map((warning) => ({
      kind: warning.kind,
      ...(warning.path === undefined ? {} : { path: warning.path }),
      ...(warning.missingFields === undefined
        ? {}
        : {
            missing_fields: warning.missingFields.map((field) => ({
              path: field.path,
              ...(field.envVariable === undefined ? {} : { env_variable: field.envVariable }),
            })),
          }),
    })),
    masked: changeSet.masked,
    unmanaged: changeSet.unmanaged,
    counts: {
      ...changeSet.counts,
      written,
      skipped: changeSet.counts.total - written,
    },
  };
}
