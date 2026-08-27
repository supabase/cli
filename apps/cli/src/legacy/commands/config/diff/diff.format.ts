import type { ConfigChange, ConfigChangeSet, CliConfigValueOrigin } from "@supabase/config";

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

/**
 * Extracts `dotted path → env var name` for every `env()`-resolved leaf, so a
 * change on such a property can name the variable involved.
 */
export function legacyConfigDiffEnvReferences(
  valueOrigins: ReadonlyArray<CliConfigValueOrigin> | undefined,
): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  for (const origin of valueOrigins ?? []) {
    if (origin.source === "environment" && origin.envVariable !== undefined) {
      references.set(origin.path.join("."), origin.envVariable);
    }
  }
  return references;
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

function localScope(context: LegacyConfigDiffContext): string {
  return context.appliedRemote === undefined ? "base config" : `[remotes.${context.appliedRemote}]`;
}

/** The target-echo line, printed to stderr before any comparison output. */
export function legacyConfigDiffComparisonLine(context: LegacyConfigDiffContext): string {
  const target =
    context.branch === undefined
      ? `project ${context.projectRef}`
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

function maskedNote(masked: ReadonlyArray<string>): string {
  return `Note: ${masked.length} credential value(s) not compared (masked by the API): ${masked.join(", ")}\n`;
}

/** Human-readable diff body for text mode (stdout). */
export function legacyRenderConfigDiffText(changeSet: ConfigChangeSet): string {
  const lines: Array<string> = [];
  for (const change of changeSet.changes) {
    lines.push(`${change.path} [${CLASS_LABELS[change.class]}]`);
    const local = renderValue(change.local, "(unset)");
    const env = change.envVariable === undefined ? "" : ` (from env ${change.envVariable})`;
    lines.push(`  local:  ${local}${env}`);
    lines.push(`  remote: ${renderValue(change.remote, "(not returned)")}`);
    lines.push("");
  }

  const { update, remote_only, local_only } = changeSet.counts;
  const total = update + remote_only + local_only;
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
  return `${lines.join("\n")}\n`;
}

/**
 * The structured result for `--output-format json|stream-json`. Unset sides
 * are explicit `null`s, distinguishable from empty values.
 */
export function legacyConfigDiffPayload(
  changeSet: ConfigChangeSet,
  scope: LegacyConfigDiffScope,
  context: LegacyConfigDiffContext,
): Record<string, unknown> {
  const valueEntry = (key: string, value: unknown): Record<string, unknown> => ({
    [key]: value === undefined ? null : value,
  });

  const { update, remote_only, local_only } = changeSet.counts;
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
      ...valueEntry("local", change.local),
      ...valueEntry("remote", change.remote),
      ...(change.envVariable === undefined ? {} : { env_variable: change.envVariable }),
    })),
    masked: changeSet.masked,
    counts: { update, remote_only, local_only, total: update + remote_only + local_only },
  };
}
