import {
  ENV_CAPTURE_REGEX,
  remoteNameForProjectRef,
  remoteProjectIdEntries,
} from "@supabase/config/internal";

import { sanitizeInlineName } from "../../../command-internal/http-errors.ts";

/**
 * `config pull`'s destination resolution: where a pulled value gets written — `[remotes.<label>]`
 * when the target ref is already tracked by an existing block, was named as a branch, or
 * `--remote-label` forces one; the config root otherwise. See `resolveConfigPullDestination` for
 * the exact precedence.
 */

interface ConfigPullDestinationRoot {
  readonly kind: "root";
}

interface ConfigPullDestinationRemote {
  readonly kind: "remote";
  /**
   * The `[remotes.<label>]` block's name — sanitized when this destination creates the block;
   * verbatim, matching the file's declared name, when reusing an existing one.
   */
  readonly label: string;
  /** `true` when no existing block's `project_id` matched the target ref, so
   * this pull creates `[remotes.<label>]` from scratch. */
  readonly created: boolean;
}

export type ConfigPullDestination = ConfigPullDestinationRoot | ConfigPullDestinationRemote;

interface ConfigPullScopeOk {
  readonly ok: true;
  readonly destination: ConfigPullDestination;
}

/**
 * The label that would govern this pull conflicts with an existing `[remotes.*]` block — either
 * that exact label already tracks a different project, or (only possible via `--remote-label`) a
 * different existing block already tracks the target ref. `conflictingBlock` names the block that
 * actually conflicts; `conflictingProjectId` is its `project_id`.
 */
export interface ConfigPullScopeLabelCollision {
  readonly ok: false;
  readonly reason: "label_collision";
  readonly label: string;
  readonly conflictingProjectId: string;
  /** The name of the block that actually conflicts — `label` itself for the same-name case, a
   * different existing block's name for the ref-tracked-elsewhere case. */
  readonly conflictingBlock: string;
}

/**
 * No `[remotes.*]` block's raw `project_id` literal matches the target ref, but one block's
 * `env(...)`-spelled `project_id` resolves to it — a hard error, never reused or rewritten:
 * reusing would track a match the loader itself would never select, and rewriting would erase
 * the user's env-var indirection.
 */
interface ConfigPullScopeEnvProjectId {
  readonly ok: false;
  readonly reason: "env_project_id";
  readonly label: string;
  readonly envVariables: ReadonlyArray<string>;
}

export type ConfigPullScopeResult =
  | ConfigPullScopeOk
  | ConfigPullScopeLabelCollision
  | ConfigPullScopeEnvProjectId;

export interface ResolveConfigPullDestinationInput {
  /** `LoadedCliConfig.rawDocument?.["remotes"]` — pre-`env()`-interpolation,
   * remotes intact. */
  readonly rawRemotes: unknown;
  /** `LoadedCliConfig.interpolatedRemotes` — the already-resolved `remotes`
   * subtree; used only to detect the `env_project_id` refusal. */
  readonly interpolatedRemotes: unknown;
  readonly projectRef: string;
  /**
   * The branch name the target was resolved from, when `--project-ref` named one by name rather
   * than UUID; `undefined` for a ref-shaped, linked-fallback, or UUID branch target (a UUID is
   * never a good label).
   */
  readonly branchLabelCandidate: string | undefined;
  /**
   * Whether `--project-ref` named a branch at all, by name or UUID — distinct from
   * `branchLabelCandidate`: a UUID branch target still creates a `[remotes.*]` block, falling
   * back to the resolved ref as its label.
   */
  readonly targetWasBranch: boolean;
  readonly requestedLabel: string | undefined;
}

/**
 * Strips control characters from a label before it becomes a `[remotes.<label>]` document-path
 * segment or inline output. Quoting for TOML is `applyConfigEdits`'s job (`renderKeySegment`),
 * not this function's. Every candidate label is sanitized before comparison too, so a value like
 * `stag\x01ing` (which sanitizes to `staging`) can't evade colliding with an existing block.
 */
export function sanitizeRemoteLabel(label: string): string {
  return sanitizeInlineName(label);
}

function extractEnvVariables(rawProjectId: string | undefined): ReadonlyArray<string> {
  if (rawProjectId === undefined) {
    return [];
  }
  const match = ENV_CAPTURE_REGEX.exec(rawProjectId);
  return match?.[1] === undefined ? [] : [match[1]];
}

// Applied to a final, sanitized label from either `--remote-label` or a branch name: reuse a
// block by that name that already tracks the target ref, refuse if it only resolves there via
// `env(...)`, or collide with whichever block actually conflicts — otherwise create fresh.
function resolveNamedLabelDestination(input: {
  readonly finalLabel: string;
  readonly rawRemotes: unknown;
  readonly interpolatedRemotes: unknown;
  readonly projectRef: string;
  readonly matchedByRef: string | undefined;
}): ConfigPullScopeResult {
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

export function resolveConfigPullDestination(
  input: ResolveConfigPullDestinationInput,
): ConfigPullScopeResult {
  const matchedByRef = remoteNameForProjectRef(input.rawRemotes, input.projectRef);

  // --remote-label forces a destination, resolved first (even for a ref-shaped target), so an
  // env()-spelled match elsewhere in the file never refuses a fresh, explicitly-requested block.
  if (input.requestedLabel !== undefined) {
    return resolveNamedLabelDestination({
      finalLabel: sanitizeRemoteLabel(input.requestedLabel),
      rawRemotes: input.rawRemotes,
      interpolatedRemotes: input.interpolatedRemotes,
      projectRef: input.projectRef,
      matchedByRef,
    });
  }

  // Block reuse is the primary signal, regardless of how the target was named.
  if (matchedByRef !== undefined) {
    return { ok: true, destination: { kind: "remote", label: matchedByRef, created: false } };
  }

  // An env()-spelled match anywhere is a hard error, never reused; only reached when no
  // --remote-label was given.
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

  // A branch-named target applies the same named-label rule to its derived label; matchedByRef
  // is always undefined here, so this can only collide on a same-name, different-project block.
  if (input.targetWasBranch) {
    const label = input.branchLabelCandidate ?? input.projectRef;
    return resolveNamedLabelDestination({
      finalLabel: sanitizeRemoteLabel(label),
      rawRemotes: input.rawRemotes,
      interpolatedRemotes: input.interpolatedRemotes,
      projectRef: input.projectRef,
      matchedByRef: undefined,
    });
  }

  // Otherwise: a ref-shaped --project-ref or linked-fallback target writes to the config root.
  return { ok: true, destination: { kind: "root" } };
}
