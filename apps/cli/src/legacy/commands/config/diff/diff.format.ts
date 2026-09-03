import type { ConfigChange, ConfigChangeSet } from "@supabase/config/internal";

import { legacySanitizeInlineName } from "../../../shared/legacy-http-errors.ts";
import {
  legacyConfigChangePayloadEntry,
  type LegacyConfigApiScope,
  legacyConfigMaskedCaveat,
  legacyConfigNotReturnedCaveat,
  legacyConfigPlural,
  legacyConfigRenderPath,
  legacyConfigRenderValue,
  legacyConfigTargetPhrase,
  legacyConfigUnmanagedCaveat,
} from "../config.format.ts";

/**
 * Pure formatters, payload builders, and input adapters for `config diff` —
 * no Effect, no services, unit-testable in isolation. The API-scope
 * classification, target-naming phrase, value/path rendering, and
 * masked/unmanaged/not-returned caveat wording shared with `config pull` live
 * in `../config.format.ts` (hoisted, CLI-2064).
 */

export interface LegacyConfigDiffContext {
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
 * Version of the machine payload's own shape — bump when the payload
 * contract changes incompatibly. Distinct from the config document's
 * `$schema` URL (`config_schema` in the payload), which is user-controlled
 * and per-repo.
 */
export const LEGACY_CONFIG_DIFF_PAYLOAD_VERSION = 1;

const CLASS_LABELS: Record<ConfigChange["class"], string> = {
  update: "update",
  remote_only: "remote-only",
  local_only: "local-only",
};

function localScope(context: LegacyConfigDiffContext): string {
  return context.appliedRemote === undefined
    ? "base config"
    : `[remotes.${legacySanitizeInlineName(context.appliedRemote)}]`;
}

/** The target-echo line, printed to stderr before any comparison output. */
export function legacyConfigDiffComparisonLine(context: LegacyConfigDiffContext): string {
  return `Comparing against ${legacyConfigTargetPhrase(context)} using ${localScope(context)}\n`;
}

/**
 * One-line summary including the not-returned/masked/unmanaged caveats — the
 * text-mode count line's caveats also travel with the machine-mode
 * `message`, so an agent echoing `.message` never reports "in sync" on a
 * partial response (e.g. a scoped token returning `auth: {}`) or a project
 * whose masked SMTP password (or unpushable declared value) may have
 * drifted.
 */
export function legacyConfigDiffSummaryMessage(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigApiScope,
): string {
  const total = changeSet.counts.total;
  const base =
    total === 0
      ? "No config differences found."
      : `${legacyConfigPlural(total, "config difference", "config differences")} found.`;
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

function renderLocal(change: ConfigChange): string {
  const value = legacyConfigRenderValue(change.local, "(unset)");
  // A populated local value on an undeclared path is the schema default the
  // projection materialized — the value a `config push` would write. Say so,
  // or "[remote-only]" reads as "this key exists only remotely", which is
  // false for anything with a schema default (and the user will grep their
  // file for a value that isn't there).
  return change.local !== undefined && !change.declared
    ? `${value} (schema default — not declared in config.toml)`
    : value;
}

/** Human-readable diff body for text mode (stdout). */
export function legacyRenderConfigDiffText(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigApiScope,
): string {
  const lines: Array<string> = [];
  for (const change of changeSet.changes) {
    lines.push(`${legacyConfigRenderPath(change.path)} [${CLASS_LABELS[change.class]}]`);
    const env =
      change.envVariables === undefined
        ? ""
        : ` (from env ${legacySanitizeInlineName(change.envVariables.join(", "))})`;
    lines.push(`  local:  ${renderLocal(change)}${env}`);
    lines.push(`  remote: ${legacyConfigRenderValue(change.remote, "(not returned)")}`);
    lines.push("");
  }

  const { update, remote_only, local_only, total } = changeSet.counts;
  if (total === 0) {
    lines.push("No config differences found.");
  } else {
    lines.push(
      `${legacyConfigPlural(total, "difference", "differences")} found (${update} update, ${remote_only} remote-only, ${local_only} local-only).`,
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
 * The structured result for `--output-format json|stream-json` (the only
 * machine-output mechanism this command honors — `-o/--output` is rejected
 * outright, CLI-2156). Unset sides are explicit `null`s, distinguishable from
 * empty values. Paths are segment arrays — a record key (an `sms.test_otp`
 * phone number, a `[remotes.*]` name) may itself contain a `.`, so consumers
 * must never split a joined string.
 */
export function legacyConfigDiffPayload(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigApiScope,
  context: LegacyConfigDiffContext,
): Record<string, unknown> {
  return {
    // The payload contract's own version — what a forward-compat consumer
    // gates on. The user's `$schema` document reference is `config_schema`:
    // user-controlled and per-repo, never a contract signal.
    schema_version: LEGACY_CONFIG_DIFF_PAYLOAD_VERSION,
    config_schema: context.configSchema,
    target: {
      project_ref: context.projectRef,
      // Omitted (not null) when no branch was targeted — the documented
      // contract says optional.
      ...(context.branch === undefined ? {} : { branch: context.branch }),
      local_scope:
        context.appliedRemote === undefined ? "base" : `remotes.${context.appliedRemote}`,
    },
    scope: { present: scope.present, missing: scope.missing },
    changes: changeSet.changes.map(legacyConfigChangePayloadEntry),
    masked: changeSet.masked,
    unmanaged: changeSet.unmanaged,
    counts: changeSet.counts,
  };
}
