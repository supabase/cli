import { type ConfigChange, projectConfigApiBlockKeys } from "@supabase/config/internal";

import { LEGACY_BRANCH_UUID_PATTERN } from "../../shared/legacy-ref-patterns.ts";
import { legacySanitizeInlineName } from "../../shared/legacy-http-errors.ts";

/**
 * Shared pure formatters, payload fragments, and input adapters for the
 * `config` command family (`diff`, `pull`) — no Effect, no services,
 * unit-testable in isolation. Hoisted out of `diff/diff.format.ts` once
 * `config pull` needed the same API-scope classification, target-naming
 * phrase, value/path rendering, and masked/unmanaged/not-returned caveat
 * wording (CLI-2064, Hoist Before You Duplicate).
 *
 * Every non-constant string interpolated into TEXT output goes through
 * `legacySanitizeInlineName`: path segments (`[remotes.*]` names,
 * `sms.test_otp` record keys) and env-var/branch names are unconstrained
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

export interface LegacyConfigApiScope {
  /** Blocks the response's `data.attributes` carried with at least one key. */
  readonly present: ReadonlyArray<string>;
  /** Blocks absent from the response — or present but EMPTY, which is how a
   * permission-truncated response most plausibly reports a block it could
   * not read; claiming an empty block was "compared" would be false. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Human-readable labels for `ConfigChange.class`, hyphenated for prose
 * (`remote_only` reads as "this key exists only remotely", but the raw enum
 * token is not itself prose). Owned here so `diff`/`pull` never disagree on
 * how a class renders; `diff.format.ts` still keeps its own private copy
 * (unifying it onto this export is a follow-up, CLI-2064 — the two are
 * identical today).
 */
export const LEGACY_CONFIG_CLASS_LABELS: Record<ConfigChange["class"], string> = {
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
export function legacyConfigApiScope(
  attributes: Readonly<Record<string, unknown>>,
): LegacyConfigApiScope {
  const present = REMOTE_CONFIG_BLOCKS.filter((block) => isPopulatedBlockRecord(attributes[block]));
  return {
    present,
    missing: REMOTE_CONFIG_BLOCKS.filter((block) => !present.includes(block)),
  };
}

/** The scope-echo line, printed to stderr once the response arrived. */
export function legacyConfigScopeLine(scope: LegacyConfigApiScope): string {
  const present = scope.present.length === 0 ? "(none)" : scope.present.join(", ");
  const suffix = scope.missing.length === 0 ? "" : ` (not returned: ${scope.missing.join(", ")})`;
  return `Comparison scope: ${present}${suffix}\n`;
}

/**
 * The target-naming fragment shared by `config diff`'s comparison line
 * (`Comparing against <phrase> using ...`) and `config pull`'s destination
 * line (`Pulling config from <phrase> -> [remotes.staging]`): `project
 * abcdefghij` for a bare project ref, `'staging' (branch abcdefghij)` for a
 * branch name, or `branch <uuid> (project ref abcdefghij)` for a branch UUID
 * — a UUID is an identifier, not a display name, so it is never quoted as
 * one.
 */
export interface LegacyConfigTargetPhraseInput {
  readonly projectRef: string;
  readonly branch: string | undefined;
}

export function legacyConfigTargetPhrase(target: LegacyConfigTargetPhraseInput): string {
  const projectRef = legacySanitizeInlineName(target.projectRef);
  if (target.branch === undefined) {
    return `project ${projectRef}`;
  }
  return LEGACY_BRANCH_UUID_PATTERN.test(target.branch)
    ? `branch ${legacySanitizeInlineName(target.branch)} (project ref ${projectRef})`
    : `'${legacySanitizeInlineName(target.branch)}' (branch ${projectRef})`;
}

export function legacyConfigRenderValue(value: unknown, absent: string): string {
  if (value === undefined) {
    return absent;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Display-only join — `ConfigChange.path` is segment-array everywhere else. */
export function legacyConfigRenderPath(path: ReadonlyArray<string>): string {
  return legacySanitizeInlineName(path.join("."));
}

export function legacyConfigPlural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function nullableValueEntry(key: string, value: unknown): Record<string, unknown> {
  return { [key]: value === undefined ? null : value };
}

/**
 * The base machine-payload entry for one `ConfigChange` — shared by `config
 * diff`'s payload and `config pull`'s planned-change payload (which layers
 * `written`/`skipped_reason` on top).
 */
export function legacyConfigChangePayloadEntry(change: ConfigChange): Record<string, unknown> {
  return {
    path: change.path,
    class: change.class,
    declared: change.declared,
    ...nullableValueEntry("local", change.local),
    ...nullableValueEntry("remote", change.remote),
    ...(change.envVariables === undefined ? {} : { env_variables: change.envVariables }),
  };
}

export function legacyConfigMaskedCaveat(masked: ReadonlyArray<ReadonlyArray<string>>): string {
  return `${legacyConfigPlural(masked.length, "credential value", "credential values")} not compared (masked by the API): ${masked.map(legacyConfigRenderPath).join(", ")}`;
}

export function legacyConfigUnmanagedCaveat(
  unmanaged: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const phrase =
    unmanaged.length === 1
      ? "1 declared property cannot be pushed and was not compared"
      : `${unmanaged.length} declared properties cannot be pushed and were not compared`;
  return `${phrase}: ${unmanaged.map(legacyConfigRenderPath).join(", ")}`;
}

/**
 * Block names come from `REMOTE_CONFIG_BLOCKS` (the schema-derived list), not
 * from the response body, so — unlike the masked/unmanaged path lists — there
 * is no sanitization concern here; still styled the same way as those two
 * caveats for consistency.
 */
export function legacyConfigNotReturnedCaveat(missing: ReadonlyArray<string>): string {
  const phrase =
    missing.length === 1
      ? "1 block was not returned by the API and was not compared"
      : `${missing.length} blocks were not returned by the API and were not compared`;
  return `${phrase}: ${missing.join(", ")}`;
}
