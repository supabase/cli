import type { ConfigChange, ConfigChangeSet } from "@supabase/config";

import { LEGACY_BRANCH_UUID_PATTERN } from "../../../shared/legacy-branch-ref.resolver.ts";

/**
 * Pure formatters, payload builders, and input adapters for `config diff` —
 * no Effect, no services, unit-testable in isolation.
 */

/** The per-service blocks of the v2 project-config resource. */
const REMOTE_CONFIG_BLOCKS = ["api", "auth", "database", "pooler", "realtime", "storage"] as const;

export type LegacyConfigDiffScope = ReadonlyArray<(typeof REMOTE_CONFIG_BLOCKS)[number]>;

function isRemoteBlockRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which per-service blocks the response's `data.attributes` actually carried
 * — echoed to the user so a partially-populated response is never mistaken
 * for a clean bill of health.
 */
export function legacyConfigDiffScope(
  attributes: Readonly<Record<string, unknown>>,
): LegacyConfigDiffScope {
  return REMOTE_CONFIG_BLOCKS.filter((block) => isRemoteBlockRecord(attributes[block]));
}

export interface LegacyConfigDiffContext {
  /** The resolved comparison target's project ref. */
  readonly projectRef: string;
  /** The `--target` value, when a branch was named. */
  readonly branch: string | undefined;
  /** Matched `[remotes.<name>]` block, when the local operand was merged. */
  readonly appliedRemote: string | undefined;
  /** The local file's `$schema` ref (or the current schema URL). */
  readonly schemaVersion: string;
}

const CLASS_LABELS: Record<ConfigChange["class"], string> = {
  update: "update",
  remote_only: "remote only",
  local_only: "local only",
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
  return path.join(".");
}

function localScope(context: LegacyConfigDiffContext): string {
  return context.appliedRemote === undefined ? "base config" : `[remotes.${context.appliedRemote}]`;
}

/** The target-echo line, printed to stderr before any comparison output. */
export function legacyConfigDiffComparisonLine(context: LegacyConfigDiffContext): string {
  // A UUID target is an identifier, not a display name — quoting it as
  // `'1111…'` would imply the branch is literally named that.
  const target =
    context.branch === undefined
      ? `project ${context.projectRef}`
      : LEGACY_BRANCH_UUID_PATTERN.test(context.branch)
        ? `branch ${context.branch} (project ref ${context.projectRef})`
        : `'${context.branch}' (branch ${context.projectRef})`;
  return `Comparing against ${target} using ${localScope(context)}\n`;
}

/** The scope-echo line, printed to stderr once the response arrived. */
export function legacyConfigDiffScopeLine(scope: LegacyConfigDiffScope): string {
  const present = scope.length === 0 ? "(none)" : scope.join(", ");
  const missing = REMOTE_CONFIG_BLOCKS.filter((block) => !scope.includes(block));
  const suffix = missing.length === 0 ? "" : ` (not returned: ${missing.join(", ")})`;
  return `Comparison scope: ${present}${suffix}\n`;
}

function maskedNote(masked: ReadonlyArray<ReadonlyArray<string>>): string {
  return `Note: ${masked.length} credential value(s) not compared (masked by the API): ${masked.map(renderPath).join(", ")}\n`;
}

function unmanagedNote(unmanaged: ReadonlyArray<ReadonlyArray<string>>): string {
  const phrase =
    unmanaged.length === 1
      ? "1 declared property cannot be pushed and was not compared"
      : `${unmanaged.length} declared properties cannot be pushed and were not compared`;
  return `Note: ${phrase}: ${unmanaged.map(renderPath).join(", ")}\n`;
}

function renderLocal(change: ConfigChange): string {
  const value = renderValue(change.local, "(unset)");
  // A populated local value on an undeclared path is the schema default the
  // projection materialized — the value a `config push` would write. Say so,
  // or "[remote only]" reads as "this key exists only remotely", which is
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
      change.envVariables === undefined ? "" : ` (from env ${change.envVariables.join(", ")})`;
    lines.push(`  local:  ${renderLocal(change)}${env}`);
    lines.push(`  remote: ${renderValue(change.remote, "(not returned)")}`);
    lines.push("");
  }

  const { update, remote_only, local_only, total } = changeSet.counts;
  if (total === 0) {
    lines.push("No config differences found.");
  } else {
    lines.push(
      `${total} difference(s) found (${update} update, ${remote_only} remote-only, ${local_only} local-only).`,
    );
  }
  if (changeSet.masked.length > 0) {
    lines.push(maskedNote(changeSet.masked).trimEnd());
  }
  if (changeSet.unmanaged.length > 0) {
    lines.push(unmanagedNote(changeSet.unmanaged).trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The structured result for `--output-format json|stream-json`. Unset sides
 * are explicit `null`s, distinguishable from empty values. Paths are segment
 * arrays — a record key (an `sms.test_otp` phone number, a `[remotes.*]`
 * name) may itself contain a `.`, so consumers must never split a joined
 * string.
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
    schema_version: context.schemaVersion,
    target: {
      project_ref: context.projectRef,
      ...valueEntry("branch", context.branch),
      local_scope:
        context.appliedRemote === undefined ? "base" : `remotes.${context.appliedRemote}`,
    },
    scope,
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
