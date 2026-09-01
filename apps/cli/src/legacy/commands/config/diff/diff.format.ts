import {
  type ConfigChange,
  type ConfigChangeSet,
  projectConfigApiBlockKeys,
} from "@supabase/config/internal";

import { LEGACY_BRANCH_UUID_PATTERN } from "../../../shared/legacy-branch-ref.resolver.ts";
import { legacySanitizeInlineName } from "../../../shared/legacy-http-errors.ts";

/**
 * Pure formatters, payload builders, and input adapters for `config diff` —
 * no Effect, no services, unit-testable in isolation.
 *
 * Every non-constant string interpolated into TEXT output goes through
 * `legacySanitizeInlineName`: path segments (`[remotes.*]` names,
 * `sms.test_otp` record keys) and env-var names are unconstrained
 * user/API-controlled strings, so a hostile value could otherwise emit raw
 * ANSI or forge output lines (e.g. a name ending `\nNo config differences
 * found.`). JSON output needs no sanitizing — `JSON.stringify` escapes
 * control characters.
 */

/**
 * The per-service blocks of the v2 project-config resource — owned by
 * `@supabase/config` (derived from its response mirror), never hand-copied
 * here, so a block the package learns is never reported "not returned"
 * forever.
 */
const REMOTE_CONFIG_BLOCKS: ReadonlyArray<string> = projectConfigApiBlockKeys;

export interface LegacyConfigDiffScope {
  /** Blocks the response's `data.attributes` carried with at least one key. */
  readonly present: ReadonlyArray<string>;
  /** Blocks absent from the response — or present but EMPTY, which is how a
   * permission-truncated response most plausibly reports a block it could
   * not read; claiming an empty block was "compared" would be false. */
  readonly missing: ReadonlyArray<string>;
}

function isPopulatedBlockRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/**
 * Which per-service blocks the response's `data.attributes` actually carried
 * — echoed to the user so a partially-populated response is never mistaken
 * for a clean bill of health.
 */
export function legacyConfigDiffScope(
  attributes: Readonly<Record<string, unknown>>,
): LegacyConfigDiffScope {
  const present = REMOTE_CONFIG_BLOCKS.filter((block) => isPopulatedBlockRecord(attributes[block]));
  return {
    present,
    missing: REMOTE_CONFIG_BLOCKS.filter((block) => !present.includes(block)),
  };
}

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

function renderValue(value: unknown, absent: string): string {
  if (value === undefined) {
    return absent;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Display-only join — `ConfigChange.path` is segment-array everywhere else. */
function renderPath(path: ReadonlyArray<string>): string {
  return legacySanitizeInlineName(path.join("."));
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function localScope(context: LegacyConfigDiffContext): string {
  return context.appliedRemote === undefined
    ? "base config"
    : `[remotes.${legacySanitizeInlineName(context.appliedRemote)}]`;
}

/** The target-echo line, printed to stderr before any comparison output. */
export function legacyConfigDiffComparisonLine(context: LegacyConfigDiffContext): string {
  // A UUID target is an identifier, not a display name — quoting it as
  // `'1111…'` would imply the branch is literally named that.
  const projectRef = legacySanitizeInlineName(context.projectRef);
  const target =
    context.branch === undefined
      ? `project ${projectRef}`
      : LEGACY_BRANCH_UUID_PATTERN.test(context.branch)
        ? `branch ${legacySanitizeInlineName(context.branch)} (project ref ${projectRef})`
        : `'${legacySanitizeInlineName(context.branch)}' (branch ${projectRef})`;
  return `Comparing against ${target} using ${localScope(context)}\n`;
}

/** The scope-echo line, printed to stderr once the response arrived. */
export function legacyConfigDiffScopeLine(scope: LegacyConfigDiffScope): string {
  const present = scope.present.length === 0 ? "(none)" : scope.present.join(", ");
  const suffix = scope.missing.length === 0 ? "" : ` (not returned: ${scope.missing.join(", ")})`;
  return `Comparison scope: ${present}${suffix}\n`;
}

function maskedCaveat(masked: ReadonlyArray<ReadonlyArray<string>>): string {
  return `${plural(masked.length, "credential value", "credential values")} not compared (masked by the API): ${masked.map(renderPath).join(", ")}`;
}

function unmanagedCaveat(unmanaged: ReadonlyArray<ReadonlyArray<string>>): string {
  const phrase =
    unmanaged.length === 1
      ? "1 declared property cannot be pushed and was not compared"
      : `${unmanaged.length} declared properties cannot be pushed and were not compared`;
  return `${phrase}: ${unmanaged.map(renderPath).join(", ")}`;
}

/**
 * One-line summary including the masked/unmanaged caveats — the text-mode
 * count line's caveats also travel with the machine-mode `message`, so an
 * agent echoing `.message` never reports "in sync" on a project whose
 * masked SMTP password (or unpushable declared value) may have drifted.
 */
export function legacyConfigDiffSummaryMessage(changeSet: ConfigChangeSet): string {
  const total = changeSet.counts.total;
  const base =
    total === 0
      ? "No config differences found."
      : `${plural(total, "config difference", "config differences")} found.`;
  const parts = [base];
  if (changeSet.masked.length > 0) {
    parts.push(`${maskedCaveat(changeSet.masked)}.`);
  }
  if (changeSet.unmanaged.length > 0) {
    parts.push(`${unmanagedCaveat(changeSet.unmanaged)}.`);
  }
  return parts.join(" ");
}

function renderLocal(change: ConfigChange): string {
  const value = renderValue(change.local, "(unset)");
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
export function legacyRenderConfigDiffText(changeSet: ConfigChangeSet): string {
  const lines: Array<string> = [];
  for (const change of changeSet.changes) {
    lines.push(`${renderPath(change.path)} [${CLASS_LABELS[change.class]}]`);
    const env =
      change.envVariables === undefined
        ? ""
        : ` (from env ${legacySanitizeInlineName(change.envVariables.join(", "))})`;
    lines.push(`  local:  ${renderLocal(change)}${env}`);
    lines.push(`  remote: ${renderValue(change.remote, "(not returned)")}`);
    lines.push("");
  }

  const { update, remote_only, local_only, total } = changeSet.counts;
  if (total === 0) {
    lines.push("No config differences found.");
  } else {
    lines.push(
      `${plural(total, "difference", "differences")} found (${update} update, ${remote_only} remote-only, ${local_only} local-only).`,
    );
  }
  if (changeSet.masked.length > 0) {
    lines.push(`Note: ${maskedCaveat(changeSet.masked)}`);
  }
  if (changeSet.unmanaged.length > 0) {
    lines.push(`Note: ${unmanagedCaveat(changeSet.unmanaged)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The structured result for `--output-format json|stream-json` and the `-o`
 * machine formats. Unset sides are explicit `null`s, distinguishable from
 * empty values. Paths are segment arrays — a record key (an `sms.test_otp`
 * phone number, a `[remotes.*]` name) may itself contain a `.`, so consumers
 * must never split a joined string.
 */
export function legacyConfigDiffPayload(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigDiffScope,
  context: LegacyConfigDiffContext,
): Record<string, unknown> {
  const valueEntry = (key: string, value: unknown): Record<string, unknown> => ({
    [key]: value === undefined ? null : value,
  });

  return {
    // The payload contract's own version — what a forward-compat consumer
    // gates on. The user's `$schema` document reference is `config_schema`:
    // user-controlled and per-repo, never a contract signal.
    schema_version: LEGACY_CONFIG_DIFF_PAYLOAD_VERSION,
    config_schema: context.configSchema,
    target: {
      project_ref: context.projectRef,
      ...valueEntry("branch", context.branch),
      local_scope:
        context.appliedRemote === undefined ? "base" : `remotes.${context.appliedRemote}`,
    },
    scope: { present: scope.present, missing: scope.missing },
    changes: changeSet.changes.map((change) => ({
      path: change.path,
      class: change.class,
      declared: change.declared,
      ...valueEntry("local", change.local),
      ...valueEntry("remote", change.remote),
      ...(change.envVariables === undefined ? {} : { env_variables: change.envVariables }),
    })),
    masked: changeSet.masked,
    unmanaged: changeSet.unmanaged,
    counts: changeSet.counts,
  };
}
