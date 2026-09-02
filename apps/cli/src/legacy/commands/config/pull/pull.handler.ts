import {
  CLI_CONFIG_SCHEMA_URL,
  fromApiProjectConfig,
  ProjectConfigParseError,
  type CliConfigParseError,
  type ConfigFormat,
  type LoadedCliConfig,
} from "@supabase/config";
import {
  applyConfigEdits,
  decodeCliConfigDocumentForValidation,
  type ConfigChangeSet,
  type ConfigEdit,
  type ConfigEditRefusalReason,
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
 * paired with the file's on-disk text read immediately after — BEFORE any
 * network call or target resolution, then resolves the target and delegates
 * to `legacyRunConfigPull` (steps 5-15) — the reusable, target-agnostic
 * body. The plan's own `LegacyConfigPullInput` sketch omits the loaded
 * config/file text; this implementation carries them through explicitly (as
 * a single `LegacyConfigPullSource`) instead of reloading/re-reading inside
 * `legacyRunConfigPull`, since `legacyConfigPull` already holds both by the
 * time it delegates. Pairing them behind one exported constructor — rather
 * than two independently-assembled fields on `LegacyConfigPullInput` — is
 * what makes "loaded without overlay, text read from the same path
 * immediately after" true BY CONSTRUCTION rather than by caller convention
 * (see {@link LegacyConfigPullSource}'s own doc comment).
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
 * The env map `pull.handler.ts`'s schema-validation gate resolves `env(VAR)`
 * references against — the current process's own environment (filtered to
 * defined string values), matching what a same-process, same-invocation
 * follow-up `loadCliConfig` would see. See
 * `decodeCliConfigDocumentForValidation`'s own doc comment
 * (`@supabase/config/internal`) for why this deliberately does not re-search
 * `.env`/`.env.local`.
 */
function legacyCurrentProcessEnv(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
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
 * Extracts the family/family-root info the schema-validation gate needs from
 * a failed {@link decodeCliConfigDocumentForValidation} attempt: every
 * `SchemaIssue` the decode raised, grouped by
 * `legacyConfigPullFamilyRootForPath`'s nearest-enclosing-table rule.
 *
 * A `SchemaError`'s reported path is relative to WHICHEVER schema actually
 * failed — `CliConfigSchema` itself (root fields, unprefixed) or
 * `RemotesSchema` (a `label`-prefixed map entry) — never both, and which one
 * is determined entirely by `destination`: a root destination's writes only
 * ever touch the root portion (the remotes map is untouched, and it already
 * decoded successfully at THIS command's own initial load, so it cannot be
 * the source of a NEW failure); a remote destination's writes only ever touch
 * `remotes.<label>`, and root decode always zeroes `remotes` out before
 * running, so it cannot see this destination's writes at all. Un-prefixing a
 * remote destination's path is therefore just dropping its leading `label`
 * segment, never a lookup that could get the wrong block. Not a `SchemaError`
 * at all (should not happen — this function only ever runs against a
 * `CliConfigParseError` this same module's own decode call produced) yields
 * no families, which the caller treats as "could not attribute this failure",
 * stopping the retry loop.
 */
function legacyConfigPullFailingFamilies(
  cause: CliConfigParseError,
  destination: LegacyConfigPullDestination,
  validationDocument: Record<string, unknown>,
  rawDocument: Readonly<Record<string, unknown>>,
): ReadonlyArray<LegacyConfigPullWouldInvalidateFamily> {
  if (!Schema.isSchemaError(cause.cause)) {
    return [];
  }
  const relativeValidation = legacyConfigPullChangeRelativeValue(validationDocument, destination);
  const relativeRaw = legacyConfigPullChangeRelativeValue(rawDocument, destination);
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(cause.cause.issue);

  const families = new Map<
    string,
    {
      root: ReadonlyArray<string>;
      missingFields: Array<{ path: ReadonlyArray<string>; envVariable?: string }>;
    }
  >();
  for (const issue of issues) {
    const rawPath = issue.path?.map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    );
    if (rawPath === undefined || rawPath.length === 0) {
      continue;
    }
    const changePath = destination.kind === "root" ? rawPath : rawPath.slice(1);
    if (changePath.length === 0) {
      continue;
    }
    const root = legacyConfigPullFamilyRootForPath(changePath, relativeValidation);
    const key = pathKey(root);
    const envVariable = legacyConfigPullEnvVariableAtPath(changePath, relativeRaw);
    const field = { path: changePath, ...(envVariable === undefined ? {} : { envVariable }) };
    const existing = families.get(key);
    families.set(
      key,
      existing === undefined
        ? { root, missingFields: [field] }
        : { root, missingFields: [...existing.missingFields, field] },
    );
  }
  return [...families.values()];
}

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
 * document) through the real `CliConfigSchema` decode, with the current
 * process env and `goViperCompat` — the exact semantics the NEXT
 * `loadCliConfig` call will apply. On failure, drops every write under the
 * nearest enclosing family/provider table of each failing path
 * (`legacyDropConfigPullUnvalidatableFamilies`), re-validates, and repeats up
 * to {@link LEGACY_CONFIG_PULL_VALIDATION_ROUND_CAP} times; if validation
 * still fails once nothing more can be dropped, fails the whole command
 * (`LegacyConfigPullValidationFailedError`) rather than write.
 */
const legacyValidateConfigPullPlan = Effect.fnUntraced(function* (input: {
  readonly plan: LegacyConfigPullPlan;
  readonly rawDocument: Readonly<Record<string, unknown>>;
  readonly destination: LegacyConfigPullDestination;
  readonly projectRef: string;
  readonly configPath: string;
  readonly format: ConfigFormat;
}) {
  let plan = input.plan;
  for (let round = 0; ; round++) {
    const document = legacyConfigPullValidationDocument(
      input.rawDocument,
      plan.writes,
      plan.createdTable,
      input.projectRef,
    );
    const decoded = yield* decodeCliConfigDocumentForValidation(document, {
      env: legacyCurrentProcessEnv(),
      goViperCompat: true,
      path: input.configPath,
      format: input.format,
    }).pipe(Effect.result);
    if (Result.isSuccess(decoded)) {
      return plan;
    }
    if (round >= LEGACY_CONFIG_PULL_VALIDATION_ROUND_CAP) {
      break;
    }
    const families = legacyConfigPullFailingFamilies(
      decoded.failure,
      input.destination,
      document,
      input.rawDocument,
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
 * `legacyRunConfigPull` step 6 only when block reuse selects it — then reads
 * the file's exact on-disk text immediately after. The SAME bytes
 * `applyConfigEdits` edits later (step 13), and the baseline
 * `legacyRunConfigPull` re-reads before writing to detect a concurrent edit
 * (step 12).
 */
export const legacyOpenConfigPullSource = Effect.fnUntraced(function* () {
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const { loadLocalConfig, relativeConfigPath } = makeConfigLoader(cliSettings);

  const loaded = yield* loadLocalConfig(undefined);

  const text = yield* fs.readFileString(loaded.path).pipe(
    Effect.catchTag(
      "PlatformError",
      (cause) =>
        new LegacyConfigPullLoadConfigError({
          message: `failed to read ${relativeConfigPath(loaded.path)}: ${cause.message}`,
        }),
    ),
  );

  return { loaded, text };
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
  const initialChangeSet = yield* Effect.try({
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

  // 8. Fixpoint-expand the diff (plan §1.9, extended by CLI-2064's live-bug
  // fix): projecting a round's writes can un-gate a sibling ADR 0021's
  // disabled-provider gates would otherwise have excluded as unmanaged (e.g.
  // flipping a disabled SMS provider's `enabled` on un-gates its credential
  // siblings) — `legacyExpandConfigPullChangeSet` repeats until nothing new
  // appears. Plan the fully-expanded writes, check for a planner defect /
  // surface unpushable notes against the fixpoint's own residual (unchanged
  // from before), then run the schema-validation gate (layer 2): pull must
  // never write a file the CLI itself cannot load.
  const fixpoint = yield* Effect.try({
    try: () =>
      legacyExpandConfigPullChangeSet({
        initialChangeSet,
        baseConfig: loaded.config,
        baseDocument: loaded.document ?? {},
        valueOrigins: loaded.valueOrigins,
        remote,
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
    ),
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
