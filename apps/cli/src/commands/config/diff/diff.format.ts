import type { ConfigChangeSet } from "@supabase/config";

import { sanitizeInlineName } from "../../../command-internal/http-errors.ts";
import {
  configChangePayloadEntry,
  type ConfigApiScope,
  configMaskedCaveat,
  configNotReturnedCaveat,
  configPlural,
  configRenderChangeLines,
  configTargetPhrase,
  configUnmanagedCaveat,
} from "../config.format.ts";

/**
 * Pure formatters, payload builders, and input adapters for `config diff`. Formatting shared
 * with `config pull` lives in `../config.format.ts`.
 */

export interface ConfigDiffContext {
  /** The resolved comparison target's project ref. */
  readonly projectRef: string;
  /** The branch name or UUID `--project-ref` carried, when it named one. */
  readonly branch: string | undefined;
  /** Matched `[remotes.<name>]` block, when the local operand was merged. */
  readonly appliedRemote: string | undefined;
  /** The local file's `$schema` ref (or the current schema URL). */
  readonly configSchema: string;
}

/**
 * Version of the machine payload's own shape; bump when the contract changes incompatibly.
 * Distinct from the config document's `$schema` URL (`config_schema` in the payload), which
 * is user-controlled and per-repo.
 */
export const CONFIG_DIFF_PAYLOAD_VERSION = 1;

function localScope(context: ConfigDiffContext): string {
  return context.appliedRemote === undefined
    ? "base config"
    : `[remotes.${sanitizeInlineName(context.appliedRemote)}]`;
}

/** The target-echo line, printed to stderr before any comparison output. */
export function configDiffComparisonLine(context: ConfigDiffContext): string {
  return `Comparing against ${configTargetPhrase(context)} using ${localScope(context)}\n`;
}

/**
 * One-line summary including the not-returned/masked/unmanaged caveats, so an agent echoing
 * the machine-mode `.message` never reports "in sync" on a partial response or a value that
 * may have silently drifted (e.g. a masked SMTP password).
 */
export function configDiffSummaryMessage(
  changeSet: ConfigChangeSet,
  scope: ConfigApiScope,
): string {
  const total = changeSet.counts.total;
  const base =
    total === 0
      ? "No config differences found."
      : `${configPlural(total, "config difference", "config differences")} found.`;
  const parts = [base];
  if (scope.missing.length > 0) {
    parts.push(`${configNotReturnedCaveat(scope.missing)}.`);
  }
  if (changeSet.masked.length > 0) {
    parts.push(`${configMaskedCaveat(changeSet.masked)}.`);
  }
  if (changeSet.unmanaged.length > 0) {
    parts.push(`${configUnmanagedCaveat(changeSet.unmanaged)}.`);
  }
  return parts.join(" ");
}

/**
 * Human-readable diff body for text mode. Per-change blocks come from `configRenderChangeLines`
 * (shared with `config push`); this only adds the trailing counts/notes lines.
 */
export function renderConfigDiffText(changeSet: ConfigChangeSet, scope: ConfigApiScope): string {
  const changeLines = configRenderChangeLines(changeSet.changes);

  const lines: Array<string> = [];
  const { update, remote_only, local_only, total } = changeSet.counts;
  if (total === 0) {
    lines.push("No config differences found.");
  } else {
    lines.push(
      `${configPlural(total, "difference", "differences")} found (${update} update, ${remote_only} remote-only, ${local_only} local-only).`,
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
  return `${changeLines}${lines.join("\n")}\n`;
}

/**
 * The structured result for `--output-format json|stream-json` (the only machine-output this
 * command honors). Unset sides are explicit `null`s. Paths stay segment arrays, never a joined
 * string, since a record key (e.g. an `sms.test_otp` phone number) may itself contain a `.`.
 */
export function configDiffPayload(
  changeSet: ConfigChangeSet,
  scope: ConfigApiScope,
  context: ConfigDiffContext,
): Record<string, unknown> {
  return {
    schema_version: CONFIG_DIFF_PAYLOAD_VERSION,
    config_schema: context.configSchema,
    target: {
      project_ref: context.projectRef,
      // Omitted, not null, when no branch was targeted.
      ...(context.branch === undefined ? {} : { branch: context.branch }),
      local_scope:
        context.appliedRemote === undefined ? "base" : `remotes.${context.appliedRemote}`,
    },
    scope: { present: scope.present, missing: scope.missing },
    changes: changeSet.changes.map(configChangePayloadEntry),
    masked: changeSet.masked,
    unmanaged: changeSet.unmanaged,
    counts: changeSet.counts,
  };
}
