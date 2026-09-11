import type { ConfigChangeSet } from "@supabase/config";

import { sanitizeInlineName } from "../../../command-internal/http-errors.ts";
import {
  CONFIG_PULL_PAYLOAD_VERSION,
  configPullPayload,
  renderConfigPullText,
  type ConfigPullContext,
  type ConfigPullOutcome,
} from "../../../command-internal/config-pull-run.ts";
import {
  type ConfigApiScope,
  configMaskedCaveat,
  configNotReturnedCaveat,
  configPlural,
  configTargetPhrase,
  type ConfigTargetPhraseInput,
  configUnmanagedCaveat,
} from "../config.format.ts";
import type { ConfigPullDestination } from "./pull.scope.ts";
import type { ConfigPullPlan } from "./pull.plan.ts";

/**
 * Pure formatters, payload builders, and input adapters for `config pull` — no Effect, no
 * services. Classification/rendering shared with `config diff` lives in `../config.format.ts`;
 * the exports below come from `command-internal/config-pull-run.ts`, shared with `supabase pull`.
 */

export { CONFIG_PULL_PAYLOAD_VERSION, configPullPayload, renderConfigPullText };
export type { ConfigPullContext, ConfigPullOutcome };

/** The destination-echo line, printed to stderr before any network call —
 * shares `config diff`'s target-naming phrase so the two commands read the
 * same target the same way. */
export function configPullDestinationLine(
  target: ConfigTargetPhraseInput,
  destination: ConfigPullDestination,
): string {
  const scope =
    destination.kind === "root"
      ? "config root"
      : `[remotes.${sanitizeInlineName(destination.label)}]`;
  return `Pulling config from ${configTargetPhrase(target)} → ${scope}\n`;
}

/**
 * The label segment of `plan.createdTable` (always `["remotes", label]`; see
 * {@link ConfigPullPlan.createdTable}) — the only untrusted piece of that path. Centralizing the
 * `sanitizeInlineName` call here avoids re-deriving the indexing at each render call site.
 */
export function configPullCreatedBlockLabel(createdTable: ReadonlyArray<string>): string {
  return sanitizeInlineName(createdTable[1] ?? "");
}

/**
 * One-line summary reflecting the run's actual outcome, distinguishing "nothing to write" (no
 * differences existed) from "wrote nothing" (differences existed but were all skipped, declined,
 * or dry-run) and giving a block-only run (`plan.createdTable` set, no value writes) its own
 * wording, distinct from both.
 *
 * @param opts.withCaveats - Appends the masked/unmanaged/not-returned `Note:`s (default `true`).
 * The machine-mode `message` always keeps them; the text-mode one-line summary omits them since
 * the change-by-change body already rendered them.
 */
export function configPullSummaryMessage(
  changeSet: ConfigChangeSet,
  scope: ConfigApiScope,
  plan: ConfigPullPlan,
  outcome: ConfigPullOutcome,
  opts: { readonly withCaveats?: boolean } = {},
): string {
  const total = changeSet.counts.total;
  let base: string;
  if (plan.createdTable !== undefined && plan.writes.length === 0) {
    const scopeLabel = `[remotes.${configPullCreatedBlockLabel(plan.createdTable)}]`;
    const applyNote =
      total === 0
        ? "no config differences to apply."
        : `${configPlural(total, "difference", "differences")} found but not written (skipped).`;
    if (outcome.dryRun) {
      base = `${scopeLabel} would be created (dry run); ${applyNote}`;
    } else if (outcome.declined) {
      base = `${scopeLabel} not created (declined).`;
    } else {
      base = `Created ${scopeLabel}; ${applyNote}`;
    }
  } else if (total === 0) {
    base = "No config differences found.";
  } else if (outcome.dryRun) {
    base = `${configPlural(plan.writes.length, "change", "changes")} would be written (dry run).`;
  } else if (outcome.declined) {
    base = `${configPlural(plan.writes.length, "change", "changes")} not written (declined).`;
  } else if (plan.writes.length === 0) {
    base = "No changes written.";
  } else {
    base = `${configPlural(plan.writes.length, "change", "changes")} written.`;
  }
  if (opts.withCaveats === false) {
    return base;
  }
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
