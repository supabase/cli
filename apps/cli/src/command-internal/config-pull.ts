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
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Result, Schema, SchemaIssue } from "effect";

import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { configFileHasUncommittedChanges } from "./git-status.ts";
import { sanitizeInlineName, sanitizeErrorBody } from "./http-errors.ts";
import { BRANCH_UUID_PATTERN } from "./ref-patterns.ts";
import { promptYesNo } from "./prompt-yes-no.ts";
import { Output } from "../shared/output/output.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import {
  configDeepSetAtPath,
  configIsRecord,
  configPathKey,
} from "../commands/config/config.paths.ts";
import { loadLocalConfig, relativeConfigPath } from "../commands/config/config.load.ts";
import type { ConfigTarget } from "../commands/config/config.target.ts";
import {
  configApiScope,
  configRenderPath,
  configScopeLine,
} from "../commands/config/config.format.ts";
import { configProjectConfigTry } from "../commands/config/config.project-config.ts";
import { configReadStatusMessage } from "../commands/config/config.read-status.ts";
import {
  configPullCreatedBlockLabel,
  configPullDestinationLine,
  configPullPayload,
  configPullSummaryMessage,
  renderConfigPullText,
  type ConfigPullContext,
  type ConfigPullOutcome,
} from "../commands/config/pull/pull.format.ts";
import {
  configPullEnvVariableAtPath,
  configPullFamilyRootForPath,
  dropConfigPullUnvalidatableFamilies,
  expandConfigPullChangeSet,
  planConfigPull,
  type ConfigPullMissingField,
  type ConfigPullPlan,
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
  ConfigPullUncommittedChangesError,
  ConfigPullUnsupportedLayoutError,
  ConfigPullValidationFailedError,
  ConfigPullWriteError,
} from "../commands/config/pull/pull.errors.ts";

/** Shared config export workflow for config pull and whole-project pull. */

/**
 * The collision message (`ConfigPullRemoteLabelCollisionError`) —
 * worded differently depending on WHICH of `pull.scope.ts`'s two
 * `label_collision` situations applies, and whether the label came from an
 * explicit `--remote-label` or was derived from a branch name (only
 * `--remote-label` can ever reach the "a DIFFERENT block already tracks this
 * ref" situation — see `resolveConfigPullDestination`'s own doc
 * comment for why a branch-derived label never does).
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
 * Plan §1.9's convergence check — run once the fixpoint expansion
 * (`expandConfigPullChangeSet`, `pull.plan.ts`) has settled, and BEFORE
 * `--dry-run` returns (a planner defect must be caught even in a preview
 * run) — against the fixpoint's OWN residual (the last round's re-diff, i.e.
 * the state once every currently-planned write has been applied).
 *
 * A residual change at a path this run just planned to write means the write
 * didn't actually converge — a defect in THIS command's own planner, never a
 * user-facing condition, surfaced as a typed `ConfigPullPlanDefectError`
 * (`impossibleState`) rather than a crash: nothing has been written yet at
 * this point (this check runs BEFORE the dry-run/prompt/write/validation
 * steps), so the error can truthfully say so. A residual `unmanaged` path
 * would mean the very value this run just wrote made itself invisible to the
 * projection again. Most surviving `@supabase/config` prunes
 * (`DISABLED_SENTINEL_PRUNES`, most of `applyRawPresenceMask`) are
 * conditional on exactly the state a write establishes — a container's OWN
 * decoded `enabled`, or the raw file's OWN declared-ness — so writing a
 * value usually satisfies the very condition that would otherwise hide it
 * again. CLI-2314 retired the one `DISABLED_SENTINEL_PRUNES`-family prune
 * that didn't have this property (`auth.oauth_server`'s old unconditional
 * removal, ignoring what had just been written) — see ADR 0021's CLI-2314
 * addendum; `pull.integration.test.ts`'s "no longer trips the ADR 0021
 * unpushable warning" case pins the resulting behavior for that family. This
 * branch DOES still have a known live trigger, though, via a DIFFERENT
 * cross-path prune: `applyDisabledSentinels`'s own "cross-section rule"
 * (`project-config.ts`, search "Cross-section rule: the email rate limit")
 * deletes `auth.rate_limit.email_sent` whenever `auth.email.smtp.enabled` is
 * explicitly `false` — checked on BOTH arms, not gated by raw presence. On
 * the API arm this only spares `email_sent` when the response is genuinely
 * SPARSE (never reports `smtp_host` at all, so `enabled` decodes as absent
 * rather than an explicit `false`) — an ordinary response with
 * `smtp_host: ""` (the common "SMTP not configured" shape) still prunes it
 * there too, leaving nothing to diff. So the live trigger is narrow: a
 * sparse remote response reporting a real `rate_limit_email_sent` while
 * omitting `smtp_host` entirely, pulled into a LOCAL document that also
 * never declares `[auth.email.smtp]` (so `applyRawPresenceMask` masks the
 * just-written value again on the residual check) — see
 * `pull.integration.test.ts`'s matching case for the exact construction.
 * Retained as a structural safety net for any OTHER asymmetric/cross-path
 * prune too, not dead code: surfaced as a `"unpushable"` warning, reusing
 * the SAME
 * `plan.warnings` / `renderConfigPullText` "Warnings:" hook the
 * planner's own `dual_scope`/`duplicates_root`/`array_drift` warnings
 * already render through, rather than adding a new payload field.
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
 * Builds the FULL raw, on-disk-shaped document `pull.handler.ts`'s
 * schema-validation gate decodes: `rawDocument` (`remotes` intact,
 * pre-`env()`-interpolation — the same shape `applyConfigEdits` edits) with
 * `writes`' `documentPath`s applied, plus the new block's `project_id` when
 * this plan creates one — mirroring step 13's real `edits` array exactly, so
 * what gets validated here is what would actually be written.
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
 * Restricts a document to the subtree a `ConfigChange.path` (hosted-config,
 * destination-agnostic) is relative to: itself for a root destination, or
 * `document.remotes[label]` for a `[remotes.*]` destination — the inverse of
 * `documentPathFor` (`pull.plan.ts`), needed because the schema-validation
 * gate's failing paths (and the pre-write raw document it looks up an env()
 * spelling in) must be read in the SAME namespace `ConfigChange.path`/the
 * plan's family-root helpers already use.
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
 * A failed {@link decodeCliConfigDocumentForValidationEffect} attempt's own
 * `SchemaIssue` paths, converted to `ConfigChange.path`-relative ("change
 * path") segments — the SAME destination-agnostic namespace `write.change.path`
 * already lives in, regardless of where a write physically lands in the
 * document.
 *
 * `isLabelPrefixed` picks between the TWO shapes a decode's own issue paths
 * can take — entirely independent of `destination.kind`, since it is the
 * PROJECTION (raw vs. `remoteName`-merged; see
 * {@link validateConfigPullPlan}) that determines this, not the
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
 * Groups already-resolved change-paths (`configPullSchemaIssueChangePaths`,
 * already filtered by the caller to exclude every PRE-EXISTING failure) by
 * `configPullFamilyRootForPath`'s nearest-enclosing-table rule,
 * enriching each with its local `env(VAR)` spelling when it has one.
 * `relativeValidation`/`relativeRaw` are always the DESTINATION-relative view
 * (`configPullChangeRelativeValue`) — the subtree a change-path is
 * actually relative to on disk — regardless of which projection (raw or
 * `remoteName`-merged) reported the failure: a merged projection's own issue
 * paths already arrive change-path-relative (see the sibling function
 * above), but the SHAPE this function reads off `document` (an enclosing
 * "family" table, a field's local raw spelling) lives at the same
 * destination-relative location either way.
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
 * The change-path keys ({@link configPathKey}) that already fail
 * {@link decodeCliConfigDocumentForValidationEffect} in `rawDocument` AS IT
 * SITS ON DISK RIGHT NOW — before this pull's own writes are projected onto
 * it. {@link validateConfigPullPlan} excludes every one of these from
 * the families it forms: the file was already in that state, so pull
 * attributing the failure to its own plan, dropping a write over it, or
 * failing the whole command over it would all be wrong — pulling only ever
 * needs to leave the file NO WORSE than it already was. Runs the SAME two
 * projections the round-by-round gate below runs (raw, plus
 * `remoteName`-merged for a remote destination), so a pre-existing failure
 * that only surfaces once a `[remotes.*]` block is SELECTED is exempted too.
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

/** Cap on how many times {@link validateConfigPullPlan} drops a family
 * and re-validates — die-free: hitting the cap fails the whole command with a
 * typed `ConfigPullValidationFailedError` rather than writing (per that
 * error's own doc comment, reaching the cap "shouldn't happen", since
 * dropping a family always restores a state that loaded before this pull
 * ran). */
const CONFIG_PULL_VALIDATION_ROUND_CAP = 4;

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
 * this pull touched it ({@link configPullPreExistingFailingChangePathKeys})
 * is PRE-EXISTING: never attributed to this plan, never dropped, never a
 * reason to fail the command — the file was already in that state, and pull
 * leaves it no worse. Only a NEW failing change-path drives the drop below:
 * every write under its nearest enclosing family/provider table
 * (`dropConfigPullUnvalidatableFamilies`), re-validated, repeating up
 * to {@link CONFIG_PULL_VALIDATION_ROUND_CAP} times; if validation
 * still fails on a NEW path once nothing more can be dropped, fails the whole
 * command (`ConfigPullValidationFailedError`) rather than write.
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

/** Builds the file-load helpers for one `cliSettings.workdir` — a small
 * factory rather than a shared closure so both `openConfigPullSource`
 * (steps 2-3) and `runConfigPull` (step 6's conditional reload) get
 * their own, independently testable copy without threading `cliSettings`
 * through {@link ConfigPullInput}. Narrowed to `workdir` +
 * `explicitWorkdir` (rather than the full `CommandSettings` shape) since
 * that's all `loadLocalConfig` (`../config.load.ts`, shared with
 * `config diff`/`config push`) needs — it owns the parse/duplicate-remote/
 * missing-file message shapes and the ancestor-search decision
 * (`shouldSearchAncestors`); only this family's own tagged error class
 * is local. */
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
 * The paired base config load + its exact on-disk text, produced ONLY by
 * {@link openConfigPullSource} — never assembled by hand elsewhere, so
 * "loaded with NO `[remotes.*]` overlay" and "text read from the SAME path
 * immediately after that load" are true by construction, not by caller
 * convention.
 */
export interface ConfigPullSource {
  readonly loaded: LoadedCliConfig;
  readonly text: string;
}

/**
 * Opens `config pull`'s base config source (`configPull` steps 2-3):
 * loads the local config with NO `[remotes.*]` overlay applied — the overlay
 * is keyed by the RESOLVED target ref, applied later inside
 * `runConfigPull` step 6 only when block reuse selects it — then takes
 * `loaded.rawText` (`@supabase/config`'s own capture of the exact bytes it
 * parsed) as this pull's baseline text, rather than reading the file a
 * second time: a separate read here would reopen a window for a concurrent
 * edit to land BETWEEN the parsed load and that read, silently becoming the
 * accepted baseline while the plan below is computed against the (now
 * stale) parsed values. The SAME bytes `applyConfigEdits` edits later
 * (step 13), and the baseline `runConfigPull` re-reads before writing
 * to detect a concurrent edit (step 12).
 */
export const openConfigPullSource = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const { loadConfig, toRelativeConfigPath } = makeConfigLoader(cliSettings);

  const loaded = yield* loadConfig(undefined);

  if (loaded.rawText === undefined) {
    // The loader contract guarantees `rawText` for any file it actually
    // parsed off disk — reaching this would mean that contract broke. Fail
    // the same way a genuine concurrent edit does, rather than falling back
    // to a second read that would reopen the exact race this baseline
    // exists to close.
    return yield* new ConfigPullFileChangedError({
      message: `${toRelativeConfigPath(loaded.path)} could not be read: the config loader returned no on-disk text. Rerun the command.`,
    });
  }

  return { loaded, text: loaded.rawText };
});

/**
 * Steps 5-15 of `config pull`, reusable independently of the CLI flag
 * surface (plan §1.6's library seam) — everything AFTER the target is known.
 * Returns the outcome so composed commands can stop after a declined confirmation.
 */
export interface ConfigPullInput {
  readonly target: ConfigTarget;
  /** `--remote-label`, already filtered so an empty value reads as absent. */
  readonly remoteLabel: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
  /** `--yes` OR `SUPABASE_YES` (the GLOBAL flag — `resolveYes`, no
   * project-`.env` fallback: unlike `config push`, this command never loads
   * one). */
  readonly yes: boolean;
  /**
   * The base config load + its on-disk text (`configPull` steps 2-3),
   * produced by {@link openConfigPullSource} BEFORE target resolution
   * (a malformed config must not burn a branch-resolution round trip) — so
   * `configPull` already holds it by the time it delegates here,
   * passed through rather than reopened.
   */
  readonly source: ConfigPullSource;
}

export const runConfigPull = Effect.fnUntraced(function* (input: ConfigPullInput) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const { ref, branch } = input.target;
  const { loadConfig, toRelativeConfigPath } = makeConfigLoader(cliSettings);

  // 5. Resolve WHERE this pull writes (root vs. an existing/new
  // `[remotes.*]` block) — pure, no network call — then print the
  // destination line to stderr BEFORE any network call.
  const branchLabelCandidate =
    branch !== undefined && !BRANCH_UUID_PATTERN.test(branch) ? branch : undefined;
  const scopeResult = resolveConfigPullDestination({
    rawRemotes: input.source.loaded.rawDocument?.["remotes"],
    interpolatedRemotes: input.source.loaded.interpolatedRemotes,
    projectRef: ref,
    branchLabelCandidate,
    targetWasBranch: branch !== undefined,
    requestedLabel: input.remoteLabel,
  });
  if (!scopeResult.ok) {
    if (scopeResult.reason === "label_collision") {
      return yield* new ConfigPullRemoteLabelCollisionError({
        message: configPullLabelCollisionMessage(scopeResult, input.remoteLabel !== undefined),
      });
    }
    return yield* new ConfigPullRemoteEnvRefError({
      message: `[remotes.${sanitizeInlineName(scopeResult.label)}].project_id is spelled as env(${scopeResult.envVariables.map((name) => sanitizeInlineName(name)).join(", ")}), but the config loader matches project_id literally — this block has never applied to any project (supabase start and config push have both been ignoring it). Replace it with the literal ref ${sanitizeInlineName(ref)} to make the block real, or pass --remote-label <name> to write a new block instead.`,
    });
  }
  const destination = scopeResult.destination;
  yield* output.raw(configPullDestinationLine({ projectRef: ref, branch }, destination), "stderr");

  // 6. Reload WITH the `[remotes.*]` overlay only when block reuse selected
  // an EXISTING block — a brand-new block has nothing to overlay yet.
  let loaded = input.source.loaded;
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

  // Project the response through CLI-2230's convergence normalizer (ADR
  // 0021) and classify — same typed/defect boundary as `config diff`
  // (`configProjectConfigTry`, shared across the `config` family).
  const remote = yield* configProjectConfigTry(() => fromApiProjectConfig(responseJson));
  const initialChangeSet = yield* configProjectConfigTry(() =>
    diffProjectConfig({ local: loaded, remote }),
  );

  const data = configIsRecord(responseJson) ? responseJson["data"] : undefined;
  const scope = configApiScope(
    configIsRecord(data) && configIsRecord(data["attributes"]) ? data["attributes"] : {},
  );
  yield* output.raw(configScopeLine(scope), "stderr");

  // 8. Fixpoint-expand the diff (plan §1.9, extended by CLI-2064's live-bug
  // fix): projecting a round's writes can un-gate a sibling ADR 0021's
  // disabled-provider gates would otherwise have excluded as unmanaged (e.g.
  // flipping a disabled SMS provider's `enabled` on un-gates its credential
  // siblings) — `expandConfigPullChangeSet` repeats until nothing new
  // appears. Plan the fully-expanded writes, check for a planner defect /
  // surface unpushable notes against the fixpoint's own residual (unchanged
  // from before), then run the schema-validation gate (layer 2): pull must
  // never write a file the CLI itself cannot load.
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
    rootDocument: input.source.loaded.document ?? {},
    projectRef: ref,
  });
  const planWithDefectCheck = yield* configPullDefectAndUnpushableCheck(plan, fixpoint.residual);
  const finalPlan = yield* validateConfigPullPlan({
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
  const emitOutcome = (planForOutput: ConfigPullPlan, outcome: ConfigPullOutcome) =>
    output.format !== "text"
      ? output.success(
          configPullSummaryMessage(changeSet, scope, planForOutput, outcome),
          configPullPayload(changeSet, scope, planForOutput, context, outcome),
        )
      : output.raw(
          `${configPullSummaryMessage(changeSet, scope, planForOutput, outcome, { withCaveats: false })}\n`,
        );

  // 9. `--dry-run`: preview only. Never runs the git check, never prompts,
  // never touches the file. Comes before the `hasWork` short-circuit below —
  // a planner defect must be visible even on a run that would do nothing.
  if (input.dryRun) {
    if (output.format === "text") {
      yield* output.raw(renderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath));
    }
    yield* emitOutcome(finalPlan, { dryRun: true, declined: false });
    return { dryRun: true, declined: false };
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
      yield* output.raw(renderConfigPullText(changeSet, scope, finalPlan, ref, context.configPath));
    }
    yield* emitOutcome(finalPlan, { dryRun: false, declined: false });
    return { dryRun: false, declined: false };
  }

  // 10. Git dirty guard (plan §1.4), reached only when there's work to do.
  // `--force` skips it entirely — no check, no warning, no prompt-default
  // flip. `--yes` aborts rather than bypasses (CLI-2064 item C): no human is
  // on hand to read the warning and answer the prompt honestly once `--yes`
  // answers it automatically, on any TTY.
  let dirty = false;
  if (!input.force) {
    const dirtyOption = yield* configFileHasUncommittedChanges(loaded.path);
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
  // Reuses the SAME `plan.warnings` hook the planner's own path-scoped
  // warnings render through (`renderConfigPullText`'s "Warnings:"
  // section) — a repository-level warning, no `path`.
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
      destination.kind === "remote" ? ` [remotes.${sanitizeInlineName(destination.label)}]` : "";
    confirmMessage = `Apply ${planForRender.writes.length} change(s) to ${context.configPath}${destinationSuffix}?`;
  } else if (planForRender.createdTable !== undefined) {
    confirmMessage = `Create [remotes.${configPullCreatedBlockLabel(planForRender.createdTable)}] in ${context.configPath}?`;
  } else {
    // Unreachable: `writes.length === 0` only reaches this branch when
    // `hasWork` was true, which (post the step-9.5 short-circuit above) means
    // `createdTable` must be set.
    return yield* Effect.die(
      new Error("config pull: nothing to confirm — hasWork invariant violated"),
    );
  }
  const confirmed = yield* promptYesNo(output, input.yes, confirmMessage, dirty ? false : true);
  if (!confirmed) {
    // Mirrors `config push`'s own treatment of a declined confirmation (each
    // service is marked "skipped" and the command still succeeds) — a
    // decline is a normal, expected outcome, not a failure: exit code stays
    // 0 in every format.
    yield* emitOutcome(planForRender, { dryRun: false, declined: true });
    return { dryRun: false, declined: true };
  }

  // 12. Re-read and compare against the step-3 baseline — someone may have
  // edited the file while the prompt was on screen.
  const currentText = yield* fs.readFileString(loaded.path).pipe(
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
    const location = path.length === 0 ? "" : ` at ${configRenderPath(path)}`;
    return yield* new ConfigPullUnsupportedLayoutError({
      message: `cannot write ${context.configPath}: ${configPullRefusalPhrase(reason)}${location} — ${detail}. ${configPullRefusalRemediation(reason)}`,
    });
  }
  yield* writeCliConfigDocumentText(loaded.path, editOutcome.text).pipe(
    Effect.catchTag(
      "CliConfigWriteError",
      (cause) => new ConfigPullWriteError({ message: cause.message }),
    ),
  );

  // 14. Final summary/payload.
  yield* emitOutcome(planForRender, { dryRun: false, declined: false });
  return { dryRun: false, declined: false };
});
