import type { ConfigChange } from "@supabase/config";
import { projectConfigApiBlockKeys } from "@supabase/config/internal";

import { BRANCH_UUID_PATTERN } from "../../command-internal/ref-patterns.ts";
import { sanitizeInlineName } from "../../command-internal/http-errors.ts";

/**
 * Shared pure formatters for the `config` family (`diff`, `pull`, `push`). Text-output strings
 * are sanitized with `sanitizeInlineName` since path segments and env/branch names are
 * user-controlled and could otherwise inject ANSI or forge output lines.
 */

// Blocks owned by @supabase/config's response mirror, never hand-copied here, so a new block
// the package learns about is never permanently reported "not returned".
const REMOTE_CONFIG_BLOCKS: ReadonlyArray<string> = projectConfigApiBlockKeys;

export interface ConfigApiScope {
  /** Blocks the response's `data.attributes` carried with at least one key. */
  readonly present: ReadonlyArray<string>;
  /** Blocks absent from the response, or present but empty — how a permission-truncated
   * response reports a block it couldn't read. An empty block was never actually compared. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Human-readable labels for `ConfigChange.class`, hyphenated for prose. Owned here so
 * `diff`/`pull`/`push` never disagree on how a class renders.
 */
export const CONFIG_CLASS_LABELS: Record<ConfigChange["class"], string> = {
  update: "update",
  remote_only: "remote-only",
  local_only: "local-only",
};

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
export function configApiScope(attributes: Readonly<Record<string, unknown>>): ConfigApiScope {
  const present = REMOTE_CONFIG_BLOCKS.filter((block) => isPopulatedBlockRecord(attributes[block]));
  return {
    present,
    missing: REMOTE_CONFIG_BLOCKS.filter((block) => !present.includes(block)),
  };
}

/** The scope-echo line, printed to stderr once the response arrived. */
export function configScopeLine(scope: ConfigApiScope): string {
  const present = scope.present.length === 0 ? "(none)" : scope.present.join(", ");
  const suffix = scope.missing.length === 0 ? "" : ` (not returned: ${scope.missing.join(", ")})`;
  return `Comparison scope: ${present}${suffix}\n`;
}

/**
 * Formats a target for `config diff`'s comparison line and `config pull`'s destination line:
 * `project <ref>` for a bare project ref, `'<name>' (branch <ref>)` for a branch name, or
 * `branch <uuid> (project ref <ref>)` for a branch UUID. A UUID is quoted as an identifier,
 * not a display name.
 */
export interface ConfigTargetPhraseInput {
  readonly projectRef: string;
  readonly branch: string | undefined;
}

export function configTargetPhrase(target: ConfigTargetPhraseInput): string {
  const projectRef = sanitizeInlineName(target.projectRef);
  if (target.branch === undefined) {
    return `project ${projectRef}`;
  }
  return BRANCH_UUID_PATTERN.test(target.branch)
    ? `branch ${sanitizeInlineName(target.branch)} (project ref ${projectRef})`
    : `'${sanitizeInlineName(target.branch)}' (branch ${projectRef})`;
}

export function configRenderValue(value: unknown, absent: string): string {
  if (value === undefined) {
    return absent;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Display-only join — `ConfigChange.path` is segment-array everywhere else. */
export function configRenderPath(path: ReadonlyArray<string>): string {
  return sanitizeInlineName(path.join("."));
}

export function configPlural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function nullableValueEntry(key: string, value: unknown): Record<string, unknown> {
  return { [key]: value === undefined ? null : value };
}

/**
 * The base machine-payload entry for one `ConfigChange`, shared by `config diff`'s payload
 * and `config pull`'s (which layers `written`/`skipped_reason` on top).
 */
export function configChangePayloadEntry(change: ConfigChange): Record<string, unknown> {
  return {
    path: change.path,
    class: change.class,
    declared: change.declared,
    ...nullableValueEntry("local", change.local),
    ...nullableValueEntry("remote", change.remote),
    ...(change.envVariables === undefined ? {} : { env_variables: change.envVariables }),
  };
}

function renderLocalChangeValue(change: ConfigChange): string {
  const value = configRenderValue(change.local, "(unset)");
  // A populated value on an undeclared path is the schema default a `config push` would write.
  // Say so, or "[remote-only]" reads as "exists only remotely", which is false when a schema
  // default exists.
  return change.local !== undefined && !change.declared
    ? `${value} (schema default — not declared in config.toml)`
    : value;
}

/**
 * Renders one `<path> [<class>]` / `local:` / `remote:` block per change, ending in a blank
 * line — including after the last — so callers can append directly without checking for a
 * trailing newline. Shared by `config diff`'s text body and `config push`'s update blocks.
 */
export function configRenderChangeLines(changes: ReadonlyArray<ConfigChange>): string {
  return changes
    .map((change) => {
      const env =
        change.envVariables === undefined
          ? ""
          : ` (from env ${sanitizeInlineName(change.envVariables.join(", "))})`;
      const block = [
        `${configRenderPath(change.path)} [${CONFIG_CLASS_LABELS[change.class]}]`,
        `  local:  ${renderLocalChangeValue(change)}${env}`,
        `  remote: ${configRenderValue(change.remote, "(not returned)")}`,
      ].join("\n");
      return `${block}\n\n`;
    })
    .join("");
}

export function configMaskedCaveat(masked: ReadonlyArray<ReadonlyArray<string>>): string {
  return `${configPlural(masked.length, "credential value", "credential values")} not compared (masked by the API): ${masked.map(configRenderPath).join(", ")}`;
}

// Wording stays cause-neutral: a path can be hidden because its own section is disabled, a
// different field is undeclared, or another option was selected instead — "not part of the
// current comparison" covers all of them without overclaiming a specific reason.
export function configUnmanagedCaveat(unmanaged: ReadonlyArray<ReadonlyArray<string>>): string {
  const phrase =
    unmanaged.length === 1
      ? "1 declared property is not part of the current comparison and was not compared"
      : `${unmanaged.length} declared properties are not part of the current comparison and were not compared`;
  return `${phrase}: ${unmanaged.map(configRenderPath).join(", ")}`;
}

/**
 * Block names come from the schema-derived `REMOTE_CONFIG_BLOCKS` list, not the response body,
 * so — unlike the masked/unmanaged caveats — there's no sanitization concern here.
 */
export function configNotReturnedCaveat(missing: ReadonlyArray<string>): string {
  const phrase =
    missing.length === 1
      ? "1 block was not returned by the API and was not compared"
      : `${missing.length} blocks were not returned by the API and were not compared`;
  return `${phrase}: ${missing.join(", ")}`;
}
