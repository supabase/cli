import {
  ENV_CAPTURE_REGEX,
  remoteNameForProjectRef,
  remoteProjectIdEntries,
} from "@supabase/config/internal";

import { legacySanitizeInlineName } from "../../../shared/legacy-http-errors.ts";

/**
 * `config pull`'s scope resolution: WHERE a pulled value gets written —
 * `[remotes.<label>]` when the target project ref is already tracked by an
 * existing block (or the target was named as a branch, or `--remote-label`
 * forces one), the config ROOT otherwise. Pure and synchronous (CLI-2064) —
 * no Effect, no services, matching `../config.target.ts`'s target resolution
 * it composes with.
 *
 * Precedence, evaluated in this order:
 * 1. `--remote-label` forces a destination — even for a ref-shaped target —
 *    and is resolved FIRST, before the env()-hard-error check below (a fresh
 *    `--remote-label` must never be refused merely because some UNRELATED
 *    block's `project_id` happens to resolve to the target ref).
 * 2. Failing that, block reuse — `config diff`'s own reuse rule (ADR 0018) —
 *    applies regardless of how the target was named: `remoteNameForProjectRef`
 *    (`@supabase/config/internal`) against the RAW, pre-`env()`-interpolation
 *    literal (`LoadedCliConfig.rawDocument`), never the resolved value
 *    (`LoadedCliConfig.interpolatedRemotes`). See that function's own doc
 *    comment for why an `env(REF)`-spelled `project_id` that happens to
 *    RESOLVE to the target ref must never match here (Decision 1: hard
 *    error, never reused, never rewritten).
 * 3. Failing that, an `env(...)`-resolving match ANYWHERE is the hard error
 *    (Decision 1) — checked only when no `--remote-label` was given (rule 1
 *    already settled the destination for that case).
 * 4. Failing that, a branch-named target creates/reuses `[remotes.<label>]`,
 *    applying the SAME named-label rule `--remote-label` uses (step 1) to its
 *    own derived label: a branch name that happens to already name an
 *    existing block tracking a DIFFERENT project is a collision too, not a
 *    silent overwrite of that block's `project_id` (this is what stranded
 *    stale overrides before this rule existed).
 * 5. Otherwise: the config root.
 */

export interface LegacyConfigPullDestinationRoot {
  readonly kind: "root";
}

export interface LegacyConfigPullDestinationRemote {
  readonly kind: "remote";
  /**
   * The `[remotes.<label>]` block's name — sanitized (control-char
   * stripped, `legacySanitizeRemoteLabel`) when this destination CREATES the
   * block; verbatim, matching the file's own declared name exactly, when
   * REUSING an existing one (an already-written label is never rewritten by
   * this resolver).
   */
  readonly label: string;
  /** `true` when no existing block's `project_id` matched the target ref, so
   * this pull creates `[remotes.<label>]` from scratch. */
  readonly created: boolean;
}

export type LegacyConfigPullDestination =
  | LegacyConfigPullDestinationRoot
  | LegacyConfigPullDestinationRemote;

export interface LegacyConfigPullScopeOk {
  readonly ok: true;
  readonly destination: LegacyConfigPullDestination;
}

/**
 * The label that would govern this pull — either `--remote-label` or a
 * branch-derived name — conflicts with an existing `[remotes.*]` block.
 * `label` is the FINAL SANITIZED label that triggered the check (matching
 * `legacySanitizeRemoteLabel(rawRequestedOrDerivedLabel)`, never the raw,
 * unsanitized flag/branch value — a hostile value that only LOOKS distinct
 * from an existing block's name before sanitization must still be caught).
 * Two distinct situations both surface here (kept as one variant — the
 * plan of record treats them as the same user-facing remediation shape,
 * just worded differently by the caller depending on which applies):
 *  - The label names an EXISTING `[remotes.<label>]` block whose own
 *    `project_id` differs from the target ref: `conflictingBlock` equals
 *    `label` itself, and `conflictingProjectId` is that block's own RAW
 *    `project_id` literal — writing here would silently start tracking the
 *    wrong project's remote (or, for a branch-derived label, would REPLACE
 *    that unrelated block's `project_id`, stranding its own overrides).
 *  - The label names NOTHING existing, but a DIFFERENT block already
 *    matches the target ref (block reuse's own primary signal — only
 *    reachable via an explicit `--remote-label`, since a branch-derived
 *    label only ever reaches this function once block reuse has already
 *    come up empty): `conflictingBlock` is that OTHER block's own name, and
 *    `conflictingProjectId` is always the target ref itself, since that is
 *    exactly why it matched — signaling "this ref is already tracked
 *    elsewhere; drop --remote-label to reuse that block, or rename it".
 */
export interface LegacyConfigPullScopeLabelCollision {
  readonly ok: false;
  readonly reason: "label_collision";
  readonly label: string;
  readonly conflictingProjectId: string;
  /** The name of the block that actually conflicts — `label` itself for the
   * same-name case, a DIFFERENT existing block's name for the
   * ref-tracked-elsewhere case. */
  readonly conflictingBlock: string;
}

/**
 * No `[remotes.*]` block's RAW `project_id` literal matches the target ref,
 * but one block's `env(...)`-spelled `project_id` RESOLVES to it (plan of
 * record, Decision 1: env()-spelled matches are a hard error — never reused,
 * never rewritten. Reusing would silently start tracking a match the loader
 * itself would never select for a read; rewriting the block's `project_id`
 * would erase the user's env-var indirection).
 */
export interface LegacyConfigPullScopeEnvProjectId {
  readonly ok: false;
  readonly reason: "env_project_id";
  readonly label: string;
  readonly envVariables: ReadonlyArray<string>;
}

export type LegacyConfigPullScopeResult =
  | LegacyConfigPullScopeOk
  | LegacyConfigPullScopeLabelCollision
  | LegacyConfigPullScopeEnvProjectId;

export interface LegacyResolveConfigPullDestinationInput {
  /** `LoadedCliConfig.rawDocument?.["remotes"]` — pre-`env()`-interpolation,
   * remotes intact. */
  readonly rawRemotes: unknown;
  /** `LoadedCliConfig.interpolatedRemotes` — the already-resolved `remotes`
   * subtree; used only to detect the `env_project_id` refusal. */
  readonly interpolatedRemotes: unknown;
  readonly projectRef: string;
  /**
   * The branch NAME the target was resolved from, when `--project-ref` named
   * one AND spelled it as a name rather than a UUID — `undefined` for a
   * ref-shaped target, a linked-fallback target, AND a UUID branch target (a
   * UUID is never a good label; see `targetWasBranch`).
   */
  readonly branchLabelCandidate: string | undefined;
  /**
   * Whether `--project-ref` named a branch at all (by name OR by UUID) —
   * distinct from `branchLabelCandidate` being set: a UUID branch target
   * still creates a `[remotes.*]` block, just falling back to the resolved
   * project ref itself as the label instead of a name-derived one.
   */
  readonly targetWasBranch: boolean;
  readonly requestedLabel: string | undefined;
}

/**
 * Control-character strip for a label about to become both a persisted
 * `[remotes.<label>]` document-path segment and inline text/JSON output —
 * mirrors `legacySanitizeInlineName`'s hostile-string defense (PR #6168) so
 * the label is clean at the point it is WRITTEN, not merely at the point
 * it's later displayed (every future read of the file already gets a clean
 * value, without relying on each consumer to re-sanitize it). QUOTING the
 * label for TOML — bare-if-safe, basic-quoted otherwise — is
 * `applyConfigEdits`'s job (`renderKeySegment`), not this function's.
 *
 * Every candidate label (`--remote-label`, branch-derived) is sanitized
 * BEFORE it is compared against existing block names, not merely before it
 * is written on the create path: comparing the raw, unsanitized value would
 * let `--remote-label $'stag\x01ing'` (which sanitizes to `staging`) slip
 * past an existing `[remotes.staging]` block tracking a different project
 * entirely, instead of colliding with it.
 */
export function legacySanitizeRemoteLabel(label: string): string {
  return legacySanitizeInlineName(label);
}

function extractEnvVariables(rawProjectId: string | undefined): ReadonlyArray<string> {
  if (rawProjectId === undefined) {
    return [];
  }
  const match = ENV_CAPTURE_REGEX.exec(rawProjectId);
  return match?.[1] === undefined ? [] : [match[1]];
}

/**
 * The one rule applied to a FINAL, SANITIZED label — whether it came from
 * `--remote-label` or was derived from a branch name — that both
 * `legacyResolveConfigPullDestination`'s rule 1 and rule 4 delegate to:
 * reuse when an existing block by that name already tracks the target ref,
 * refuse when it merely resolves there via `env(...)`, collide when it
 * tracks something else, and otherwise either collide (a DIFFERENT block
 * already tracks the ref — only possible for the `--remote-label` caller,
 * since `matchedByRef` is always `undefined` by the time the branch-derived
 * caller reaches this function) or create a fresh block.
 */
function resolveNamedLabelDestination(input: {
  readonly finalLabel: string;
  readonly rawRemotes: unknown;
  readonly interpolatedRemotes: unknown;
  readonly projectRef: string;
  readonly matchedByRef: string | undefined;
}): LegacyConfigPullScopeResult {
  const existingEntry = remoteProjectIdEntries(input.rawRemotes).find(
    (entry) => entry.name === input.finalLabel,
  );
  if (existingEntry !== undefined) {
    if (existingEntry.projectId === input.projectRef) {
      return {
        ok: true,
        destination: { kind: "remote", label: existingEntry.name, created: false },
      };
    }
    const interpolatedEntry = remoteProjectIdEntries(input.interpolatedRemotes).find(
      (entry) => entry.name === existingEntry.name,
    );
    if (interpolatedEntry !== undefined && interpolatedEntry.projectId === input.projectRef) {
      return {
        ok: false,
        reason: "env_project_id",
        label: existingEntry.name,
        envVariables: extractEnvVariables(existingEntry.projectId),
      };
    }
    return {
      ok: false,
      reason: "label_collision",
      label: input.finalLabel,
      conflictingProjectId: existingEntry.projectId,
      conflictingBlock: existingEntry.name,
    };
  }
  if (input.matchedByRef !== undefined) {
    return {
      ok: false,
      reason: "label_collision",
      label: input.finalLabel,
      conflictingProjectId: input.projectRef,
      conflictingBlock: input.matchedByRef,
    };
  }
  return {
    ok: true,
    destination: { kind: "remote", label: input.finalLabel, created: true },
  };
}

export function legacyResolveConfigPullDestination(
  input: LegacyResolveConfigPullDestinationInput,
): LegacyConfigPullScopeResult {
  const matchedByRef = remoteNameForProjectRef(input.rawRemotes, input.projectRef);

  // 1. `--remote-label` forces a destination, resolved FIRST — even for a
  // ref-shaped target — so its own remedy ("pass --remote-label") is never
  // dead: an env()-spelled match ELSEWHERE in the file must never refuse a
  // fresh, explicitly-requested block.
  if (input.requestedLabel !== undefined) {
    return resolveNamedLabelDestination({
      finalLabel: legacySanitizeRemoteLabel(input.requestedLabel),
      rawRemotes: input.rawRemotes,
      interpolatedRemotes: input.interpolatedRemotes,
      projectRef: input.projectRef,
      matchedByRef,
    });
  }

  // 2. Block reuse — the primary signal, regardless of how the target was
  // named (mirrors `config diff`'s own reuse rule).
  if (matchedByRef !== undefined) {
    return { ok: true, destination: { kind: "remote", label: matchedByRef, created: false } };
  }

  // 3. env()-spelled match anywhere — hard error, never reused (Decision 1).
  // Only reached when no `--remote-label` was given (step 1 already settled
  // the destination for that case).
  const envMatch = remoteProjectIdEntries(input.interpolatedRemotes).find(
    (entry) => entry.projectId === input.projectRef,
  );
  if (envMatch !== undefined) {
    const rawEntry = remoteProjectIdEntries(input.rawRemotes).find(
      (entry) => entry.name === envMatch.name,
    );
    return {
      ok: false,
      reason: "env_project_id",
      label: envMatch.name,
      envVariables: extractEnvVariables(rawEntry?.projectId),
    };
  }

  // 4. Target was named as a branch (name or UUID) — apply the SAME
  // named-label rule to its own derived label. `matchedByRef` is always
  // `undefined` here (step 2 already returned otherwise), so this can only
  // ever collide on a same-NAME, different-project block, never on "a
  // different block already tracks the ref" (step 2 covers that case).
  if (input.targetWasBranch) {
    const label = input.branchLabelCandidate ?? input.projectRef;
    return resolveNamedLabelDestination({
      finalLabel: legacySanitizeRemoteLabel(label),
      rawRemotes: input.rawRemotes,
      interpolatedRemotes: input.interpolatedRemotes,
      projectRef: input.projectRef,
      matchedByRef: undefined,
    });
  }

  // 5. Otherwise: a ref-shaped `--project-ref` or linked-fallback target —
  // write to the config root.
  return { ok: true, destination: { kind: "root" } };
}
