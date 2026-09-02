import type { ConfigFormat } from "@supabase/config";
import type { ConfigChange, ConfigChangeSet } from "@supabase/config/internal";

import { legacySanitizeInlineName } from "../../../shared/legacy-http-errors.ts";
import {
  LEGACY_CONFIG_CLASS_LABELS,
  legacyConfigChangePayloadEntry,
  type LegacyConfigApiScope,
  legacyConfigMaskedCaveat,
  legacyConfigNotReturnedCaveat,
  legacyConfigPlural,
  legacyConfigRenderPath,
  legacyConfigRenderValue,
  legacyConfigTargetPhrase,
  type LegacyConfigTargetPhraseInput,
  legacyConfigUnmanagedCaveat,
} from "../config.format.ts";
import type { LegacyConfigPullDestination } from "./pull.scope.ts";
import type {
  LegacyConfigPullPlan,
  LegacyConfigPullSkipReason,
  LegacyConfigPullWarning,
} from "./pull.plan.ts";

/**
 * Pure formatters, payload builders, and input adapters for `config pull` —
 * no Effect, no services, unit-testable in isolation. The API-scope
 * classification, target-naming phrase, value/path rendering, and
 * masked/unmanaged/not-returned caveat wording shared with `config diff` live
 * in `../config.format.ts` (hoisted, CLI-2064).
 */

/**
 * Version of the machine payload's own shape — bump when the payload
 * contract changes incompatibly. A NEW payload, independent of `config
 * diff`'s `LEGACY_CONFIG_DIFF_PAYLOAD_VERSION` (never bumped by this file).
 */
export const LEGACY_CONFIG_PULL_PAYLOAD_VERSION = 1;

/**
 * A change's actual disposition once the confirmation prompt (and
 * `--dry-run`) are known — broader than {@link LegacyConfigPullSkipReason}
 * (the pure PLANNING-time reason a change was never even attempted): a
 * change `legacyPlanConfigPull` planned to write still ends up unwritten when
 * the run is a dry run or the user declined.
 */
export type LegacyConfigPullChangeSkipReason = LegacyConfigPullSkipReason | "declined" | "dry_run";

/**
 * The run's actual outcome, known only after the confirmation prompt (or
 * `--dry-run`) resolves — layered on top of {@link LegacyConfigPullPlan},
 * which only knows what WOULD be written. `dryRun` and `declined` are
 * mutually exclusive: a `--dry-run` run never reaches the prompt.
 */
export interface LegacyConfigPullOutcome {
  readonly dryRun: boolean;
  /** The confirmation prompt (§1.4) was declined — every planned write
   * becomes `skipped_reason: "declined"` instead of being applied. */
  readonly declined: boolean;
}

export interface LegacyConfigPullContext {
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
  /** Matched `[remotes.<name>]` block the DIFF operand was merged from —
   * independent of `destination` (a brand-new `[remotes.*]` block being
   * CREATED has no applied overlay to diff against yet). Mirrors `config
   * diff`'s own `target.local_scope`. */
  readonly appliedRemote: string | undefined;
  readonly destination: LegacyConfigPullDestination;
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

/** The destination-echo line, printed to stderr before any network call —
 * shares `config diff`'s target-naming phrase so the two commands read the
 * same target the same way. */
export function legacyConfigPullDestinationLine(
  target: LegacyConfigTargetPhraseInput,
  destination: LegacyConfigPullDestination,
): string {
  const scope =
    destination.kind === "root"
      ? "config root"
      : `[remotes.${legacySanitizeInlineName(destination.label)}]`;
  return `Pulling config from ${legacyConfigTargetPhrase(target)} → ${scope}\n`;
}

/**
 * The label segment of `plan.createdTable` (always `["remotes", label]`, see
 * {@link LegacyConfigPullPlan.createdTable}'s own doc comment) — the only
 * untrusted piece of that path, so every caller rendering it into TEXT output
 * (the confirmation prompt, the render body's new-block note, the summary
 * message's block-only wording) runs it through `legacySanitizeInlineName`
 * here rather than re-deriving the indexing at each call site.
 */
export function legacyConfigPullCreatedBlockLabel(createdTable: ReadonlyArray<string>): string {
  return legacySanitizeInlineName(createdTable[1] ?? "");
}

interface ChangeStatus {
  readonly written: boolean;
  readonly reason?: LegacyConfigPullChangeSkipReason;
}

/**
 * Every `changeSet.changes` entry's actual disposition: `plan.writes` unless
 * the run outcome turns a planned write into a skip (`dryRun`/`declined`),
 * else `plan.skipped`'s own planning-time reason.
 */
function buildChangeStatus(
  plan: LegacyConfigPullPlan,
  outcome: LegacyConfigPullOutcome,
): ReadonlyMap<string, ChangeStatus> {
  const status = new Map<string, ChangeStatus>();
  const writeSkipReason: LegacyConfigPullChangeSkipReason | undefined = outcome.dryRun
    ? "dry_run"
    : outcome.declined
      ? "declined"
      : undefined;
  for (const write of plan.writes) {
    status.set(
      pathKey(write.change.path),
      writeSkipReason === undefined
        ? { written: true }
        : { written: false, reason: writeSkipReason },
    );
  }
  for (const skip of plan.skipped) {
    status.set(pathKey(skip.change.path), { written: false, reason: skip.reason });
  }
  return status;
}

function writtenCount(plan: LegacyConfigPullPlan, outcome: LegacyConfigPullOutcome): number {
  return outcome.dryRun || outcome.declined ? 0 : plan.writes.length;
}

function renderLocal(local: unknown, declared: boolean): string {
  const value = legacyConfigRenderValue(local, "(unset)");
  return local !== undefined && !declared
    ? `${value} (schema default — not declared in config.toml)`
    : value;
}

function warningMessage(warning: LegacyConfigPullWarning, configPath: string): string {
  const path = warning.path === undefined ? undefined : legacyConfigRenderPath(warning.path);
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
  }
}

/**
 * Text-mode-only rewording of {@link LegacyConfigPullSkipReason} for the
 * per-change marker (`legacyRenderConfigPullText`) — the machine payload's
 * own `skipped_reason` token (`legacyConfigPullPayload`) is untouched.
 */
function humanizeSkipReason(reason: LegacyConfigPullSkipReason): string {
  switch (reason) {
    case "env_reference":
      return "env() reference";
    case "unwritable":
      return "not representable";
    case "local_only":
      // Never actually reached: a `local_only` skip's own marker is built
      // directly (see `changeMarker` below), since the reason would only
      // restate the change's own class.
      return "local only";
  }
}

/**
 * The per-change marker (`write`/`skip: ...`) — suppresses the skip reason
 * when it would merely restate the change's own class (`local_only`
 * changes are ALWAYS skipped for reason `local_only`, so `[local-only, skip:
 * local_only]` says nothing a reader doesn't already know from the class
 * alone); every other skip reason is humanized for text-mode prose.
 */
function changeMarker(
  change: ConfigChange,
  writePaths: ReadonlySet<string>,
  skipReasonByPath: ReadonlyMap<string, LegacyConfigPullSkipReason>,
): string {
  if (writePaths.has(pathKey(change.path))) {
    return "write";
  }
  const reason = skipReasonByPath.get(pathKey(change.path));
  if (reason === undefined || reason === change.class) {
    return "not pulled";
  }
  return `skip: ${humanizeSkipReason(reason)}`;
}

/**
 * Human-readable change-by-change body for text mode (stdout), shown BEFORE
 * the confirmation prompt (and reused, unchanged, for `--dry-run`'s output) —
 * so it reports what the plan WOULD do, independent of the run's eventual
 * outcome. The final one-line disposition (wrote / would write / declined)
 * is {@link legacyConfigPullSummaryMessage}'s job, not this renderer's.
 *
 * A `plan.createdTable` always gets its own line naming the new block —
 * regardless of whether any value write is ALSO planned — so a block-only
 * run (a zero-drift branch/`--remote-label` target, CLI-2064 bug B) states
 * its one action in the body too, not only in its own confirmation prompt
 * (`pull.handler.ts` step 11).
 */
export function legacyRenderConfigPullText(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigApiScope,
  plan: LegacyConfigPullPlan,
  projectRef: string,
  configPath: string,
): string {
  const writePaths = new Set(plan.writes.map((write) => pathKey(write.change.path)));
  const skipReasonByPath = new Map(
    plan.skipped.map((skip) => [pathKey(skip.change.path), skip.reason] as const),
  );

  const lines: Array<string> = [];
  for (const change of changeSet.changes) {
    const marker = changeMarker(change, writePaths, skipReasonByPath);
    lines.push(
      `${legacyConfigRenderPath(change.path)} [${LEGACY_CONFIG_CLASS_LABELS[change.class]}, ${marker}]`,
    );
    const env =
      change.envVariables === undefined
        ? ""
        : ` (from env ${legacySanitizeInlineName(change.envVariables.join(", "))})`;
    lines.push(`  local:  ${renderLocal(change.local, change.declared)}${env}`);
    lines.push(`  remote: ${legacyConfigRenderValue(change.remote, "(not returned)")}`);
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
      `${legacyConfigPlural(total, "difference", "differences")} found (${plan.writes.length} to write, ${plan.skipped.length} to skip).`,
    );
  }
  if (plan.createdTable !== undefined) {
    lines.push(
      `New block [remotes.${legacyConfigPullCreatedBlockLabel(plan.createdTable)}] will be created (project_id = ${legacySanitizeInlineName(projectRef)}).`,
    );
  }
  if (scope.missing.length > 0) {
    lines.push(`Note: ${legacyConfigNotReturnedCaveat(scope.missing)}`);
  }
  if (changeSet.masked.length > 0) {
    lines.push(`Note: ${legacyConfigMaskedCaveat(changeSet.masked)}`);
  }
  if (changeSet.unmanaged.length > 0) {
    lines.push(`Note: ${legacyConfigUnmanagedCaveat(changeSet.unmanaged)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * One-line summary reflecting the run's ACTUAL outcome — the caveats travel
 * with the machine-mode `message` field the same way `config diff`'s do, so
 * an agent echoing just `.message` never mistakes a partial/declined/dry-run
 * result for a completed write. Distinguishes "nothing to write" (no
 * differences at all, no block to create) from "wrote nothing" (differences
 * existed, but every one was skipped/declined/dry-run) — the two read very
 * differently to a script deciding whether to alert.
 *
 * A BLOCK-ONLY run (`plan.createdTable` set, no value writes — a zero-drift
 * branch target, CLI-2064's bug B) gets its own wording, distinguishable both
 * from "nothing to write" (a block WAS created, or would be) and from a
 * value-writing run (`counts.written` stays 0 either way, see
 * `legacyConfigPullPayload`).
 *
 * `opts.withCaveats` (default `true`) governs whether the masked/unmanaged/
 * not-returned `Note:`s are appended: the machine-mode `message` keeps them
 * (an agent reading only `.message` must never miss a caveat), but the TEXT
 * one-line disposition printed AFTER the change-by-change body omits them —
 * that body already rendered the same `Note:` lines once, and repeating them
 * verbatim in the final summary line said nothing new.
 */
export function legacyConfigPullSummaryMessage(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigApiScope,
  plan: LegacyConfigPullPlan,
  outcome: LegacyConfigPullOutcome,
  opts: { readonly withCaveats?: boolean } = {},
): string {
  const total = changeSet.counts.total;
  let base: string;
  if (plan.createdTable !== undefined && plan.writes.length === 0) {
    const scopeLabel = `[remotes.${legacyConfigPullCreatedBlockLabel(plan.createdTable)}]`;
    if (outcome.dryRun) {
      base = `${scopeLabel} would be created (dry run); no config differences to apply.`;
    } else if (outcome.declined) {
      base = `${scopeLabel} not created (declined).`;
    } else {
      base = `Created ${scopeLabel}; no config differences to apply.`;
    }
  } else if (total === 0) {
    base = "No config differences found.";
  } else if (outcome.dryRun) {
    base = `${legacyConfigPlural(plan.writes.length, "change", "changes")} would be written (dry run).`;
  } else if (outcome.declined) {
    base = `${legacyConfigPlural(plan.writes.length, "change", "changes")} not written (declined).`;
  } else if (plan.writes.length === 0) {
    base = "No changes written.";
  } else {
    base = `${legacyConfigPlural(plan.writes.length, "change", "changes")} written.`;
  }
  if (opts.withCaveats === false) {
    return base;
  }
  const parts = [base];
  if (scope.missing.length > 0) {
    parts.push(`${legacyConfigNotReturnedCaveat(scope.missing)}.`);
  }
  if (changeSet.masked.length > 0) {
    parts.push(`${legacyConfigMaskedCaveat(changeSet.masked)}.`);
  }
  if (changeSet.unmanaged.length > 0) {
    parts.push(`${legacyConfigUnmanagedCaveat(changeSet.unmanaged)}.`);
  }
  return parts.join(" ");
}

function destinationPayload(destination: LegacyConfigPullDestination): Record<string, unknown> {
  return destination.kind === "root"
    ? { scope: "base", created: false }
    : {
        scope: `remotes.${destination.label}`,
        label: destination.label,
        created: destination.created,
      };
}

/**
 * The structured result for `--output-format json|stream-json` — the only
 * machine-output mechanism this command honors (`-o/--output` is rejected
 * outright, mirroring `config diff`, CLI-2156). Unset sides are explicit
 * `null`s (via `legacyConfigChangePayloadEntry`), distinguishable from empty
 * values.
 */
export function legacyConfigPullPayload(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigApiScope,
  plan: LegacyConfigPullPlan,
  context: LegacyConfigPullContext,
  outcome: LegacyConfigPullOutcome,
): Record<string, unknown> {
  const status = buildChangeStatus(plan, outcome);
  const written = writtenCount(plan, outcome);
  const documentPathByKey = new Map(
    plan.writes.map((write) => [pathKey(write.change.path), write.documentPath] as const),
  );
  // A block-only run (`plan.createdTable` set, no value writes) still WROTE —
  // the new block itself — even though `written` (a count of VALUE writes)
  // stays 0; `dryRun`/`declined` mean the block was only ever a plan, never
  // actually created.
  const wrote =
    written > 0 || (plan.createdTable !== undefined && !outcome.dryRun && !outcome.declined);

  return {
    schema_version: LEGACY_CONFIG_PULL_PAYLOAD_VERSION,
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
      const entry = status.get(pathKey(change.path));
      const changeWritten = entry?.written ?? false;
      const documentPath = documentPathByKey.get(pathKey(change.path));
      return {
        ...legacyConfigChangePayloadEntry(change),
        written: changeWritten,
        ...(entry?.reason === undefined ? {} : { skipped_reason: entry.reason }),
        // Only an ACTUALLY written entry carries `document_path` — a
        // dry-run/declined outcome still has a planned `documentPath`, but
        // nothing landed there, so surfacing it would overstate what
        // happened.
        ...(changeWritten && documentPath !== undefined ? { document_path: documentPath } : {}),
      };
    }),
    warnings: plan.warnings.map((warning) => ({
      kind: warning.kind,
      ...(warning.path === undefined ? {} : { path: warning.path }),
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
