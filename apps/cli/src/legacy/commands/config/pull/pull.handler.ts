import {
  CLI_CONFIG_SCHEMA_URL,
  fromApiProjectConfig,
  type CliConfigParseError,
  type ConfigFormat,
  type LoadedCliConfig,
} from "@supabase/config";
import {
  applyConfigEdits,
  decodeCliConfigDocumentForValidationEffect,
  type ConfigChangeSet,
  type ConfigEdit,
  type ConfigEditRefusalReason,
  type DecodeCliConfigDocumentForValidationEffectOptions,
  diffProjectConfig,
  loadCliConfig,
  writeCliConfigDocumentText,
} from "@supabase/config/internal";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Result, Schema, SchemaIssue } from "effect";

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
import { legacyConfigProjectConfigTry } from "../config.project-config.ts";
import { legacyConfigReadStatusMessage, legacyUnexpectedStatusMessage } from "../config.read-status.ts";
import {
  legacyConfigPullCreatedBlockLabel,
  legacyConfigPullDestinationLine,
  legacyConfigPullPayload,
  legacyConfigPullSummaryMessage,
  legacyRenderConfigPullText,
  type LegacyConfigPullContext,
  type LegacyConfigPullOutcome,
} from "./pull.format.ts";
import {
  deepSetAtPath,
  legacyConfigPullEnvVariableAtPath,
  legacyConfigPullFamilyRootForPath,
  legacyDropConfigPullUnvalidatableFamilies,
  legacyExpandConfigPullChangeSet,
  legacyPlanConfigPull,
  type LegacyConfigPullMissingField,
  type LegacyConfigPullPlan,
  type LegacyConfigPullWarning,
  type LegacyConfigPullWouldInvalidateFamily,
} from "./pull.plan.ts";
import {
  legacyResolveConfigPullDestination,
  type LegacyConfigPullDestination,
  type LegacyConfigPullScopeLabelCollision,
} from "./pull.scope.ts";
import {
  LegacyConfigPullBranchNotFoundError,
  LegacyConfigPullBranchNotLinkedError,
  LegacyConfigPullBranchNotReadyError,
  LegacyConfigPullFileChangedError,
  LegacyConfigPullLoadConfigError,
  LegacyConfigPullOutputFlagUnsupportedError,
  LegacyConfigPullParentRefInvalidError,
  LegacyConfigPullPlanDefectError,
  LegacyConfigPullReadNetworkError,
  LegacyConfigPullReadStatusError,
  LegacyConfigPullRemoteEnvRefError,
  LegacyConfigPullRemoteLabelCollisionError,
  LegacyConfigPullUncommittedChangesError,
  LegacyConfigPullUnsupportedLayoutError,
  LegacyConfigPullValidationFailedError,
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
 * `-o/--output`, then opens the base config source via
 * `legacyOpenConfigPullSource` — a load with NO `[remotes.*]` overlay,
 * paired with that SAME load's own captured on-disk text (`LoadedCliConfig.rawText`)
 * — BEFORE any network call or target resolution, then resolves the target
 * and delegates to `legacyRunConfigPull` (steps 5-15) — the reusable,
 * target-agnostic body. The plan's own `LegacyConfigPullInput` sketch omits
 * the loaded config/file text; this implementation carries them through
 * explicitly (as a single `LegacyConfigPullSource`) instead of
 * reloading/re-reading inside `legacyRunConfigPull`, since `legacyConfigPull`
 * already holds both by the time it delegates. Pairing them behind one
 * exported constructor — rather than two independently-assembled fields on
 * `LegacyConfigPullInput` — is what makes "loaded without overlay, text taken
 * from that SAME load" true BY CONSTRUCTION rather than by caller convention
 * (see {@link LegacyConfigPullSource}'s own doc comment).
 */

const mapBranchResolveError = mapLegacyHttpError({
  networkError: LegacyConfigPullReadNetworkError,
  statusError: LegacyConfigPullReadStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: legacyUnexpectedStatusMessage,
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
 * The collision message (`LegacyConfigPullRemoteLabelCollisionError`) —
 * worded differently depending on WHICH of `pull.scope.ts`'s two
 * `label_collision` situations applies, and whether the label came from an
 * explicit `--remote-label` or was derived from a branch name (only
 * `--remote-label` can ever reach the "a DIFFERENT block already tracks this
 * ref" situation — see `legacyResolveConfigPullDestination`'s own doc
 * comment for why a branch-derived label never does).
 */
function legacyConfigPullLabelCollisionMessage(
  scopeResult: LegacyConfigPullScopeLabelCollision,
  fromRemoteLabelFlag: boolean,
): string {
  const label = legacySanitizeInlineName(scopeResult.label);
  const conflictingProjectId = legacySanitizeInlineName(scopeResult.conflictingProjectId);
  const conflictingBlock = legacySanitizeInlineName(scopeResult.conflictingBlock);
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
 * `LegacyConfigPullUnsupportedLayoutError` message, only prose.
 */
function legacyConfigPullRefusalPhrase(reason: ConfigEditRefusalReason): string {
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
function legacyConfigPullRefusalRemediation(reason: ConfigEditRefusalReason): string {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

/**
 * Plan §1.9's convergence check — run once the fixpoint expansion
 * (`legacyExpandConfigPullChangeSet`, `pull.plan.ts`) has settled, and BEFORE
 * `--dry-run` returns (a planner defect must be caught even in a preview
 * run) — against the fixpoint's OWN residual (the last round's re-diff, i.e.
 * the state once every currently-planned write has been applied).
 *
 * A residual change at a path this run just planned to write means the write
 * didn't actually converge — a defect in THIS command's own planner, never a
 * user-facing condition, surfaced as a typed `LegacyConfigPullPlanDefectError`
 * (`impossibleState`) rather than a crash: nothing has been written yet at
 * this point (this check runs BEFORE the dry-run/prompt/write/validation
 * steps), so the error can truthfully say so. A residual `unmanaged` path
 * (ADR 0021's unpushable families, e.g. `auth.oauth_server` on its first
 * pull: undeclared before this run, so it planned normally, but DECLARING it
 * makes `applyPushUnmanagedOmissions` drop it from every future comparison)
 * is expected, not a defect — `config push` has no code path for these
 * fields, so a written value there can never be sent back. Surfaced as a
 * `"unpushable"` warning, reusing the SAME `plan.warnings` /
 * `legacyRenderConfigPullText` "Warnings:" hook the planner's own
 * `dual_scope`/`duplicates_root`/`array_drift` warnings already render
 * through, rather than adding a new payload field.
 */
function legacyConfigPullDefectAndUnpushableCheck(
  plan: LegacyConfigPullPlan,
  residual: ConfigChangeSet,
): Effect.Effect<LegacyConfigPullPlan, LegacyConfigPullPlanDefectError> {
  if (plan.writes.length === 0) {
    return Effect.succeed(plan);
  }
  const writtenPathKeys = new Set(plan.writes.map((write) => pathKey(write.change.path)));
  const stillDrifting = residual.changes.filter((change) =>
    writtenPathKeys.has(pathKey(change.path)),
  );
  if (stillDrifting.length > 0) {
    return new LegacyConfigPullPlanDefectError({
      message: `config pull planner defect: ${stillDrifting
        .map((change) => legacyConfigRenderPath(change.path))
        .join(
          ", ",
        )} still differ from remote after applying the planned write; nothing was written. Please report this bug.`,
    });
  }

  const unpushableWarnings: ReadonlyArray<LegacyConfigPullWarning> = residual.unmanaged
    .filter((path) => writtenPathKeys.has(pathKey(path)))
    .map((path) => ({ kind: "unpushable", path }));

  return Effect.succeed(
    unpushableWarnings.length === 0
      ? plan
      : { ...plan, warnings: [...plan.warnings, ...unpushableWarnings] },
  );
}

/**
 * Builds the FULL raw, on-disk-shaped document `pull.handler.ts`'s
 * schema-validation gate decodes: `rawDocument` (`remotes` intact,
 * pre-`env()`-interpolation — the same shape `applyConfigEdits` edits) with
 * `writes`' `documentPath`s applied, plus the new block's `project_id` when
 * this plan creates one — mirroring step 13's real `edits` array exactly, so
 * what gets validated here is what would actually be written.
 */
function legacyConfigPullValidationDocument(
  rawDocument: Readonly<Record<string, unknown>>,
  writes: ReadonlyArray<LegacyConfigPullPlan["writes"][number]>,
  createdTable: ReadonlyArray<string> | undefined,
  projectRef: string,
): Record<string, unknown> {
  const withWrites = writes.reduce(
    (document, write) => deepSetAtPath(document, write.documentPath, write.value),
    rawDocument,
  );
  return createdTable === undefined
    ? withWrites
    : deepSetAtPath(withWrites, [...createdTable, "project_id"], projectRef);
}

/**
 * Restricts a document to the subtree a `ConfigChange.path` (hosted-config,
 * destination-agnostic) is relative to: itself for a root destination, or
 * `document.remotes[label]` for a `[remotes.*]` destination — the inverse of
 * `documentPathFor` (`pull.plan.ts`), needed because the schema-validation
 * gate's failing paths (and the pre-write raw document it looks up an env()
 * spelling in) must be read in the SAME namespace `ConfigChange.path`/the
 * plan's family-root helpers already use.
 */
function legacyConfigPullChangeRelativeValue(
  document: unknown,
  destination: LegacyConfigPullDestination,
): unknown {
  if (destination.kind === "root") {
    return document;
  }
  const remotes = isRecord(document) ? document["remotes"] : undefined;
  return isRecord(remotes) ? remotes[destination.label] : undefined;
}

/**
 * A failed {@link decodeCliConfigDocumentForValidationEffect} attempt's own
 * `SchemaIssue` paths, converted to `ConfigChange.path`-relative ("change
 * path") segments — the SAME destination-agnostic namespace `write.change.path`
 * already lives in, regardless of where a write physically lands in the
 * document.
 *
 * `isLabelPrefixed` picks between the TWO shapes a decode's own issue paths
 * can take — entirely independent of `destination.kind`, since it is the
 * PROJECTION (raw vs. `remoteName`-merged; see
 * {@link legacyValidateConfigPullPlan}) that determines this, not the
 * destination: the RAW/unmerged projection of a REMOTE destination decodes
 * the whole `remotes` map through `RemotesSchema` (`disableChecks: true`),
 * whose own issue paths start with the map's OWN key — the label itself, not
 * the literal word `remotes` — so dropping that one leading segment recovers
 * the change-path form; every OTHER case (a root destination's raw
 * projection, or ANY destination's `remoteName`-merged projection, which
 * decodes the merged document at the schema ROOT) already reports
 * change-path-relative paths, nothing to strip. Not a `SchemaError` at all
 * (should not happen — this only ever runs against a `CliConfigParseError`
 * this same module's own decode calls produced) yields no paths, which
 * callers treat as "could not attribute this failure".
 */
function legacyConfigPullSchemaIssueChangePaths(
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
 * Groups already-resolved change-paths (`legacyConfigPullSchemaIssueChangePaths`,
 * already filtered by the caller to exclude every PRE-EXISTING failure) by
 * `legacyConfigPullFamilyRootForPath`'s nearest-enclosing-table rule,
 * enriching each with its local `env(VAR)` spelling when it has one.
 * `relativeValidation`/`relativeRaw` are always the DESTINATION-relative view
 * (`legacyConfigPullChangeRelativeValue`) — the subtree a change-path is
 * actually relative to on disk — regardless of which projection (raw or
 * `remoteName`-merged) reported the failure: a merged projection's own issue
 * paths already arrive change-path-relative (see the sibling function
 * above), but the SHAPE this function reads off `document` (an enclosing
 * "family" table, a field's local raw spelling) lives at the same
 * destination-relative location either way.
 */
function legacyConfigPullFamiliesForChangePaths(
  changePaths: ReadonlyArray<ReadonlyArray<string>>,
  relativeValidation: unknown,
  relativeRaw: unknown,
): ReadonlyArray<LegacyConfigPullWouldInvalidateFamily> {
  const families = new Map<
    string,
    { root: ReadonlyArray<string>; missingFields: Map<string, LegacyConfigPullMissingField> }
  >();
  for (const changePath of changePaths) {
    const root = legacyConfigPullFamilyRootForPath(changePath, relativeValidation);
    const key = pathKey(root);
    const envVariable = legacyConfigPullEnvVariableAtPath(changePath, relativeRaw);
    const field: LegacyConfigPullMissingField = {
      path: changePath,
      ...(envVariable === undefined ? {} : { envVariable }),
    };
    const existing = families.get(key);
    if (existing === undefined) {
      families.set(key, { root, missingFields: new Map([[pathKey(changePath), field]]) });
    } else {
      existing.missingFields.set(pathKey(changePath), field);
    }
  }
  return [...families.values()].map((family) => ({
    root: family.root,
    missingFields: [...family.missingFields.values()],
  }));
}

/**
 * Runs {@link decodeCliConfigDocumentForValidationEffect}, capturing only ITS
 * OWN `CliConfigParseError` failure into a `Result` the caller inspects (the
 * schema-validation gate's "did this decode" check) — `CliProjectEnvParseError`/
 * `PlatformError` (a genuinely malformed `.env`/`.env.local`, or a filesystem
 * failure reading one) are not decode-ATTRIBUTION failures at all, so they are
 * left in the returned Effect's error channel to propagate uncaught, exactly
 * like the SAME two failures already do from the real `loadCliConfig` call
 * this command's own initial load makes (`makeConfigLoader` only ever catches
 * `CliConfigParseError`/`DuplicateRemoteProjectIdError` there too).
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
 * The change-path keys ({@link pathKey}) that already fail
 * {@link decodeCliConfigDocumentForValidationEffect} in `rawDocument` AS IT
 * SITS ON DISK RIGHT NOW — before this pull's own writes are projected onto
 * it. {@link legacyValidateConfigPullPlan} excludes every one of these from
 * the families it forms: the file was already in that state, so pull
 * attributing the failure to its own plan, dropping a write over it, or
 * failing the whole command over it would all be wrong — pulling only ever
 * needs to leave the file NO WORSE than it already was. Runs the SAME two
 * projections the round-by-round gate below runs (raw, plus
 * `remoteName`-merged for a remote destination), so a pre-existing failure
 * that only surfaces once a `[remotes.*]` block is SELECTED is exempted too.
 */
const legacyConfigPullPreExistingFailingChangePathKeys = Effect.fnUntraced(function* (input: {
  readonly rawDocument: Readonly<Record<string, unknown>>;
  readonly destination: LegacyConfigPullDestination;
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
    for (const path of legacyConfigPullSchemaIssueChangePaths(
      rawDecoded.failure,
      input.destination.kind === "remote",
    )) {
      keys.add(pathKey(path));
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
      for (const path of legacyConfigPullSchemaIssueChangePaths(mergedDecoded.failure, false)) {
        keys.add(pathKey(path));
      }
    }
  }
  return keys;
});

/** Cap on how many times {@link legacyValidateConfigPullPlan} drops a family
 * and re-validates — die-free: hitting the cap fails the whole command with a
 * typed `LegacyConfigPullValidationFailedError` rather than writing (per that
 * error's own doc comment, reaching the cap "shouldn't happen", since
 * dropping a family always restores a state that loaded before this pull
 * ran). */
const LEGACY_CONFIG_PULL_VALIDATION_ROUND_CAP = 4;

/**
 * `pull.handler.ts`'s schema-validation gate (CLI-2064's live-bug fix, layer
 * 2): pull must NEVER write a file the CLI itself cannot load. Before the
 * TOCTOU re-read/write, decodes the projected FINAL document (every planned
 * write, plus a new block's `project_id`, applied to the raw on-disk
 * document) through the real `CliConfigSchema` decode, resolving `env(VAR)`
 * EXACTLY as the next `loadCliConfig` call will (`decodeCliConfigDocumentForValidationEffect`
 * — process env layered with the project's own `.env`/`.env.local`, not bare
 * `process.env`). A `[remotes.*]` destination additionally validates the
 * `remoteName`-merged projection — the same overlay a future `loadCliConfig`
 * targeting THIS project ref applies before its own checks-enabled decode —
 * since a written block can pass the raw/unmerged check (remotes decode with
 * business-rule checks disabled) yet still fail once actually selected.
 *
 * A decode failure whose change-path already failed in `rawDocument` BEFORE
 * this pull touched it ({@link legacyConfigPullPreExistingFailingChangePathKeys})
 * is PRE-EXISTING: never attributed to this plan, never dropped, never a
 * reason to fail the command — the file was already in that state, and pull
 * leaves it no worse. Only a NEW failing change-path drives the drop below:
 * every write under its nearest enclosing family/provider table
 * (`legacyDropConfigPullUnvalidatableFamilies`), re-validated, repeating up
 * to {@link LEGACY_CONFIG_PULL_VALIDATION_ROUND_CAP} times; if validation
 * still fails on a NEW path once nothing more can be dropped, fails the whole
 * command (`LegacyConfigPullValidationFailedError`) rather than write.
 */
const legacyValidateConfigPullPlan = Effect.fnUntraced(function* (input: {
  readonly plan: LegacyConfigPullPlan;
  readonly rawDocument: Readonly<Record<string, unknown>>;
  readonly destination: LegacyConfigPullDestination;
  readonly projectRef: string;
  readonly configPath: string;
  readonly format: ConfigFormat;
}) {
  const destination = input.destination;
  const preExisting = yield* legacyConfigPullPreExistingFailingChangePathKeys({
    rawDocument: input.rawDocument,
    destination,
    configPath: input.configPath,
    format: input.format,
  });

  let plan = input.plan;
  for (let round = 0; ; round++) {
    const document = legacyConfigPullValidationDocument(
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
      ? legacyConfigPullSchemaIssueChangePaths(rawDecoded.failure, destination.kind === "remote")
      : [];
    const mergedChangePaths =
      mergedDecoded !== undefined && Result.isFailure(mergedDecoded)
        ? legacyConfigPullSchemaIssueChangePaths(mergedDecoded.failure, false)
        : [];
    const allChangePaths = [...rawChangePaths, ...mergedChangePaths];
    const newChangePaths = allChangePaths.filter((path) => !preExisting.has(pathKey(path)));

    if (allChangePaths.length > 0 && newChangePaths.length === 0) {
      // Every attributable failure traces back to a problem that already
      // existed before this run touched the file — accept the plan as-is
      // rather than drop or fail over it (see
      // `legacyConfigPullPreExistingFailingChangePathKeys`'s doc comment).
      return plan;
    }

    if (round >= LEGACY_CONFIG_PULL_VALIDATION_ROUND_CAP) {
      break;
    }
    const relativeValidation = legacyConfigPullChangeRelativeValue(document, destination);
    const relativeRaw = legacyConfigPullChangeRelativeValue(input.rawDocument, destination);
    const families = legacyConfigPullFamiliesForChangePaths(
      newChangePaths,
      relativeValidation,
      relativeRaw,
    );
    const next = legacyDropConfigPullUnvalidatableFamilies(plan, families);
    if (next.writes.length === plan.writes.length) {
      // Nothing could be dropped for the reported failure(s) — retrying
      // would just repeat the same decode failure forever.
      break;
    }
    plan = next;
  }
  return yield* new LegacyConfigPullValidationFailedError({
    message: `config pull's planned writes would still leave ${input.configPath} unloadable after dropping every family the validator flagged; nothing was written. Please report this bug.`,
  });
});

/** Builds the file-load helpers for one `cliSettings.workdir` — a small
 * factory rather than a shared closure so both `legacyOpenConfigPullSource`
 * (steps 2-3) and `legacyRunConfigPull` (step 6's conditional reload) get
 * their own, independently testable copy without threading `cliSettings`
 * through {@link LegacyConfigPullInput}. */
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
 * The paired base config load + its exact on-disk text, produced ONLY by
 * {@link legacyOpenConfigPullSource} — never assembled by hand elsewhere, so
 * "loaded with NO `[remotes.*]` overlay" and "text read from the SAME path
 * immediately after that load" are true by construction, not by caller
 * convention.
 */
export interface LegacyConfigPullSource {
  readonly loaded: LoadedCliConfig;
  readonly text: string;
}

/**
 * Opens `config pull`'s base config source (`legacyConfigPull` steps 2-3):
 * loads the local config with NO `[remotes.*]` overlay applied — the overlay
 * is keyed by the RESOLVED target ref, applied later inside
 * `legacyRunConfigPull` step 6 only when block reuse selects it — then takes
 * `loaded.rawText` (`@supabase/config`'s own capture of the exact bytes it
 * parsed) as this pull's baseline text, rather than reading the file a
 * second time: a separate read here would reopen a window for a concurrent
 * edit to land BETWEEN the parsed load and that read, silently becoming the
 * accepted baseline while the plan below is computed against the (now
 * stale) parsed values. The SAME bytes `applyConfigEdits` edits later
 * (step 13), and the baseline `legacyRunConfigPull` re-reads before writing
 * to detect a concurrent edit (step 12).
 */
export const legacyOpenConfigPullSource = Effect.fnUntraced(function* () {
  const cliSettings = yield* LegacyCliSettings;
  const { loadLocalConfig, relativeConfigPath } = makeConfigLoader(cliSettings);

  const loaded = yield* loadLocalConfig(undefined);

  if (loaded.rawText === undefined) {
    // The loader contract guarantees `rawText` for any file it actually
    // parsed off disk — reaching this would mean that contract broke. Fail
    // the same way a genuine concurrent edit does, rather than falling back
    // to a second read that would reopen the exact race this baseline
    // exists to close.
    return yield* new LegacyConfigPullFileChangedError({
      message: `${relativeConfigPath(loaded.path)} could not be read: the config loader returned no on-disk text. Rerun the command.`,
    });
  }

  return { loaded, text: loaded.rawText };
});

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
   * The base config load + its on-disk text (`legacyConfigPull` steps 2-3),
   * produced by {@link legacyOpenConfigPullSource} BEFORE target resolution
   * (a malformed config must not burn a branch-resolution round trip) — so
   * `legacyConfigPull` already holds it by the time it delegates here,
   * passed through rather than reopened.
   */
  readonly source: LegacyConfigPullSource;
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
    rawRemotes: input.source.loaded.rawDocument?.["remotes"],
    interpolatedRemotes: input.source.loaded.interpolatedRemotes,
    projectRef: ref,
    branchLabelCandidate,
    targetWasBranch: branch !== undefined,
    requestedLabel: input.remoteLabel,
  });
  if (!scopeResult.ok) {
    if (scopeResult.reason === "label_collision") {
      return yield* new LegacyConfigPullRemoteLabelCollisionError({
        message: legacyConfigPullLabelCollisionMessage(
          scopeResult,
          input.remoteLabel !== undefined,
        ),
      });
    }
    return yield* new LegacyConfigPullRemoteEnvRefError({
      message: `[remotes.${legacySanitizeInlineName(scopeResult.label)}].project_id is spelled as env(${scopeResult.envVariables.map((name) => legacySanitizeInlineName(name)).join(", ")}), but the config loader matches project_id literally — this block has never applied to any project (supabase start and config push have both been ignoring it). Replace it with the literal ref ${legacySanitizeInlineName(ref)} to make the block real, or pass --remote-label <name> to write a new block instead.`,
    });
  }
  const destination = scopeResult.destination;
  yield* output.raw(
    legacyConfigPullDestinationLine({ projectRef: ref, branch }, destination),
    "stderr",
  );

  // 6. Reload WITH the `[remotes.*]` overlay only when block reuse selected
  // an EXISTING block — a brand-new block has nothing to overlay yet.
  let loaded = input.source.loaded;
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
      message: legacyConfigReadStatusMessage(response.status, body, ref),
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
  // 0021) and classify — same typed/defect boundary as `config diff`
  // (`legacyConfigProjectConfigTry`, shared across the `config` family).
  const remote = yield* legacyConfigProjectConfigTry(() => fromApiProjectConfig(responseJson));
  const initialChangeSet = yield* legacyConfigProjectConfigTry(() =>
    diffProjectConfig({ local: loaded, remote }),
  );

  const data = isRecord(responseJson) ? responseJson["data"] : undefined;
  const scope = legacyConfigApiScope(
    isRecord(data) && isRecord(data["attributes"]) ? data["attributes"] : {},
  );
  yield* output.raw(legacyConfigScopeLine(scope), "stderr");

  // 8. Fixpoint-expand the diff (plan §1.9, extended by CLI-2064's live-bug
  // fix): projecting a round's writes can un-gate a sibling ADR 0021's
  // disabled-provider gates would otherwise have excluded as unmanaged (e.g.
  // flipping a disabled SMS provider's `enabled` on un-gates its credential
  // siblings) — `legacyExpandConfigPullChangeSet` repeats until nothing new
  // appears. Plan the fully-expanded writes, check for a planner defect /
  // surface unpushable notes against the fixpoint's own residual (unchanged
  // from before), then run the schema-validation gate (layer 2): pull must
  // never write a file the CLI itself cannot load.
  const fixpoint = yield* legacyConfigProjectConfigTry(() =>
    legacyExpandConfigPullChangeSet({
      initialChangeSet,
      baseConfig: loaded.config,
      baseDocument: loaded.document ?? {},
      valueOrigins: loaded.valueOrigins,
      remote,
    }),
  );
  const changeSet = fixpoint.changeSet;
  const plan = legacyPlanConfigPull({
    changeSet,
    destination,
    rootDocument: input.source.loaded.document ?? {},
    projectRef: ref,
  });
  const planWithDefectCheck = yield* legacyConfigPullDefectAndUnpushableCheck(
    plan,
    fixpoint.residual,
  );
  const finalPlan = yield* legacyValidateConfigPullPlan({
    plan: planWithDefectCheck,
    rawDocument: input.source.loaded.rawDocument ?? {},
    destination,
    projectRef: ref,
    configPath: loaded.path,
    format: loaded.format,
  });

  // The TEXT one-line disposition drops the caveats (`opts.withCaveats:
  // false`, item F.2 of CLI-2064's fix pass) — the change-by-change body
  // above already rendered the same `Note:` lines once; the machine-mode
  // `message` keeps them, since it is the only place an agent reads them.
  const emitOutcome = (planForOutput: LegacyConfigPullPlan, outcome: LegacyConfigPullOutcome) =>
    output.format !== "text"
      ? output.success(
          legacyConfigPullSummaryMessage(changeSet, scope, planForOutput, outcome),
          legacyConfigPullPayload(changeSet, scope, planForOutput, context, outcome),
        )
      : output.raw(
          `${legacyConfigPullSummaryMessage(changeSet, scope, planForOutput, outcome, { withCaveats: false })}\n`,
        );

  // 9. `--dry-run`: preview only. Never runs the git check, never prompts,
  // never touches the file. Comes before the `hasWork` short-circuit below —
  // a planner defect must be visible even on a run that would do nothing.
  if (input.dryRun) {
    if (output.format === "text") {
      yield* output.raw(
        legacyRenderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath),
      );
    }
    yield* emitOutcome(finalPlan, { dryRun: true, declined: false });
    return;
  }

  // 9.5. Nothing planned AT ALL — no value write, no `[remotes.*]` block to
  // create — success, no git check, no prompt. `hasBlockToCreate` is why this
  // is `hasWork`, not merely `writes.length === 0`: a zero-drift branch
  // target still has WORK to do (creating the block), so it must reach the
  // git guard/confirmation below like any other write (CLI-2064 bug B). Doing
  // this check BEFORE the git guard (rather than after, as it used to run) is
  // what fixes bug A: a converged run never spawns `git status` at all, so an
  // uncommitted-but-otherwise-clean config file never aborts a pull that was
  // never going to touch it.
  const hasBlockToCreate = finalPlan.createdTable !== undefined;
  const hasWork = finalPlan.writes.length > 0 || hasBlockToCreate;
  if (!hasWork) {
    if (output.format === "text") {
      yield* output.raw(
        legacyRenderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath),
      );
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
    const dirtyOption = yield* legacyConfigFileHasUncommittedChanges(loaded.path);
    dirty = Option.getOrElse(dirtyOption, () => false);
    if (dirty) {
      const tty = yield* Tty;
      if (input.yes || output.format !== "text" || !tty.stdinIsTty) {
        return yield* new LegacyConfigPullUncommittedChangesError({
          message: `${context.configPath} has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force to write anyway.`,
        });
      }
    }
  }
  // Reuses the SAME `plan.warnings` hook the planner's own path-scoped
  // warnings render through (`legacyRenderConfigPullText`'s "Warnings:"
  // section) — a repository-level warning, no `path`.
  const planForRender: LegacyConfigPullPlan = dirty
    ? {
        ...finalPlan,
        warnings: [...finalPlan.warnings, { kind: "uncommitted_changes" }],
      }
    : finalPlan;

  if (output.format === "text") {
    yield* output.raw(
      legacyRenderConfigPullText(changeSet, scope, planForRender, ref, context.configPath),
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
      destination.kind === "remote"
        ? ` [remotes.${legacySanitizeInlineName(destination.label)}]`
        : "";
    confirmMessage = `Apply ${planForRender.writes.length} change(s) to ${context.configPath}${destinationSuffix}?`;
  } else if (planForRender.createdTable !== undefined) {
    confirmMessage = `Create [remotes.${legacyConfigPullCreatedBlockLabel(planForRender.createdTable)}] in ${context.configPath}?`;
  } else {
    // Unreachable: `writes.length === 0` only reaches this branch when
    // `hasWork` was true, which (post the step-9.5 short-circuit above) means
    // `createdTable` must be set.
    return yield* Effect.die(
      new Error("config pull: nothing to confirm — hasWork invariant violated"),
    );
  }
  const confirmed = yield* legacyPromptYesNo(
    output,
    input.yes,
    confirmMessage,
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
  if (currentText !== input.source.text) {
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
    const { reason, path, detail } = editOutcome.refusal;
    const location = path.length === 0 ? "" : ` at ${legacyConfigRenderPath(path)}`;
    return yield* new LegacyConfigPullUnsupportedLayoutError({
      message: `cannot write ${context.configPath}: ${legacyConfigPullRefusalPhrase(reason)}${location} — ${detail}. ${legacyConfigPullRefusalRemediation(reason)}`,
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
 * `-o/--output`, opens the base config source (`legacyOpenConfigPullSource`)
 * BEFORE any network call or target resolution, resolves the target, then
 * delegates to {@link legacyRunConfigPull} for the rest.
 */
export const legacyConfigPull = Effect.fn("legacy.config.pull")(function* (
  flags: LegacyConfigPullFlags,
) {
  const goOutputFlag = yield* LegacyOutputFlag;
  const yes = yield* legacyResolveYes;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

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

    // 2-3. Open the base config source (load with NO `[remotes.*]` overlay,
    // paired with its on-disk text) BEFORE any network call or target
    // resolution — a missing file must point at `supabase init` rather than
    // the resolver's not-linked error, and a malformed document must not
    // burn a branch-resolution round trip.
    const source = yield* legacyOpenConfigPullSource();

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
      source,
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
