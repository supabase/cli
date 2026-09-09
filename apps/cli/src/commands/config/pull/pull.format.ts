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
 * Pure formatters, payload builders, and input adapters for `config pull` —
 * no Effect, no services, unit-testable in isolation. The API-scope
 * classification, target-naming phrase, value/path rendering, and
 * masked/unmanaged/not-returned caveat wording shared with `config diff` live
 * in `../config.format.ts` (hoisted, CLI-2064). `configPullPayload`/
 * `renderConfigPullText`/`ConfigPullOutcome`/`ConfigPullContext`/
 * `CONFIG_PULL_PAYLOAD_VERSION` are hoisted to
 * `command-internal/config-pull-run.ts` (CLI-1272, reused by the `supabase
 * pull` orchestrator) and re-exported here so this file's own call sites and
 * test suite keep resolving them from the same path.
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
 * The label segment of `plan.createdTable` (always `["remotes", label]`, see
 * {@link ConfigPullPlan.createdTable}'s own doc comment) — the only
 * untrusted piece of that path, so every caller rendering it into TEXT output
 * (the confirmation prompt, the render body's new-block note, the summary
 * message's block-only wording) runs it through `sanitizeInlineName`
 * here rather than re-deriving the indexing at each call site.
 */
export function configPullCreatedBlockLabel(createdTable: ReadonlyArray<string>): string {
  return sanitizeInlineName(createdTable[1] ?? "");
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
 * `configPullPayload`) — and, within that wording, "no config
 * differences to apply" (`counts.total === 0`: there was truly nothing to
 * compare) is itself distinct from every difference having been SKIPPED
 * (`counts.total > 0` but every one landed in `plan.skipped` — env()
 * references, local-only fields, a dropped unvalidatable family, …): the
 * block still only ever got created for its `project_id`, but claiming "no
 * differences" would be false when differences existed and were simply never
 * written.
 *
 * `opts.withCaveats` (default `true`) governs whether the masked/unmanaged/
 * not-returned `Note:`s are appended: the machine-mode `message` keeps them
 * (an agent reading only `.message` must never miss a caveat), but the TEXT
 * one-line disposition printed AFTER the change-by-change body omits them —
 * that body already rendered the same `Note:` lines once, and repeating them
 * verbatim in the final summary line said nothing new.
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
