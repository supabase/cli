import {
  legacyFormatNamedRef,
  legacySanitizeInlineName,
} from "../../../shared/legacy-http-errors.ts";
import type { LegacyConfigPushTarget } from "./push.branch-target.ts";

/**
 * Pure formatters and payload builders for `config push`'s target-echo and
 * branch confirmation (CLI-2168) — no Effect, no services, unit-testable in
 * isolation. Every interpolated ref/name goes through `legacyFormatNamedRef`
 * (`legacySanitizeInlineName` underneath), so an API-provided branch/project
 * name can't inject ANSI/OSC/newline controls into the terminal.
 */

/**
 * The target-echo block, printed to stderr before any further network call.
 * Only the NO-NAME-AVAILABLE degradation shape — a plain project whose name
 * could not be resolved — stays byte-identical to the pre-CLI-2168
 * `Pushing config to project: <ref>` text (existing tests pin exactly that
 * shape). The plain-project SUCCESS path text is NOT byte-identical to the
 * old behavior: it now also shows the resolved name whenever one is
 * available, which for a real project is always, since `name` is a required
 * API field.
 */
export function legacyConfigPushTargetLines(target: LegacyConfigPushTarget): string {
  if (target.kind === "project") {
    return `Pushing config to project: ${legacyFormatNamedRef(target.name, target.ref)}\n`;
  }
  if (target.kind === "unknown") {
    return `Pushing config to: ${legacySanitizeInlineName(target.ref)} (could not determine whether this is a branch or the main project)\n`;
  }

  const lines: Array<string> = [
    `Pushing config to branch: ${legacyFormatNamedRef(target.branch, target.ref)}`,
  ];
  if (target.parentRef !== undefined) {
    lines.push(`  Parent project: ${legacyFormatNamedRef(target.parentName, target.parentRef)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The confirmation-prompt label gating a branch push (CLI-2168). Ends with a
 * self-serve hint (`--yes`) so a CI/agent log reading the declined prompt can
 * fix the invocation without digging through docs.
 */
export function legacyConfigPushBranchPromptLabel(
  target: LegacyConfigPushTarget & { readonly kind: "branch" },
): string {
  const ref = legacySanitizeInlineName(target.ref);
  const hint = " (skip this check with --yes)";
  return target.branch === undefined
    ? `Do you want to push config to branch ${ref}?${hint}`
    : `Do you want to push config to branch "${legacySanitizeInlineName(target.branch)}" (${ref})?${hint}`;
}

/** Additive machine-payload fields describing the resolved target
 * (CLI-2168/CLI-2289). `is_branch` is omitted (not `false`) when the target
 * couldn't be determined at all — asserting `false` would be as dishonest as
 * asserting `true`; an absent key is the correct "we don't know" signal. */
export function legacyConfigPushPayloadFields(target: LegacyConfigPushTarget): {
  readonly is_branch?: boolean;
  readonly branch?: string;
  readonly parent_project_ref?: string;
} {
  if (target.kind === "unknown") {
    return {};
  }
  return {
    is_branch: target.kind === "branch",
    ...(target.kind === "branch" && target.branch !== undefined ? { branch: target.branch } : {}),
    ...(target.kind === "branch" && target.parentRef !== undefined
      ? { parent_project_ref: target.parentRef }
      : {}),
  };
}
