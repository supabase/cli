import {
  ENV_CAPTURE_REGEX,
  remoteNameForProjectRef,
  remoteProjectIdEntries,
} from "@supabase/config/internal";

import { legacySanitizeInlineName } from "../../../shared/legacy-http-errors.ts";

/**
 * `config pull`'s scope resolution: WHERE a pulled value gets written —
 * `[remotes.<label>]` when the target project ref is already tracked by an
 * existing block (or the target was named as a branch), the config ROOT
 * otherwise. Pure and synchronous (CLI-2064) — no Effect, no services,
 * matching `../config.target.ts`'s target resolution it composes with.
 *
 * The matching rule is `config diff`'s own reuse rule (ADR 0018), reused
 * unmodified: pull writes into the SAME block a read would select —
 * `remoteNameForProjectRef` (`@supabase/config/internal`) against the RAW,
 * pre-`env()`-interpolation literal (`LoadedCliConfig.rawDocument`), never
 * the resolved value (`LoadedCliConfig.document`). See that function's own
 * doc comment for why an `env(REF)`-spelled `project_id` that happens to
 * RESOLVE to the target ref must never match here (Decision 1: hard error,
 * never reused, never rewritten).
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
 * `--remote-label` named a block that conflicts with the block reuse would
 * otherwise select. Two distinct situations both surface here (kept as one
 * variant — the plan of record treats them as the same user-facing
 * remediation, "pass a different --remote-label" or drop the flag):
 *  - The requested label names an EXISTING `[remotes.<label>]` block whose
 *    own `project_id` differs from the target ref: `conflictingProjectId` is
 *    that block's own `project_id` — writing here would silently start
 *    tracking the wrong project's remote.
 *  - No block matches the requested label at all, but a DIFFERENT block
 *    already matches the target ref (block reuse's own primary signal):
 *    `conflictingProjectId` is that matched block's `project_id` — which is
 *    always the target ref itself, since that is exactly why it matched —
 *    signaling "this ref is already tracked elsewhere; drop --remote-label
 *    to reuse that block, or pick its actual name".
 */
export interface LegacyConfigPullScopeLabelCollision {
  readonly ok: false;
  readonly reason: "label_collision";
  readonly label: string;
  readonly conflictingProjectId: string;
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

export function legacyResolveConfigPullDestination(
  input: LegacyResolveConfigPullDestinationInput,
): LegacyConfigPullScopeResult {
  // 1. Block reuse — the primary signal, regardless of `--remote-label` or
  // how the target was named (mirrors `config diff`'s own reuse rule).
  const matchedName = remoteNameForProjectRef(input.rawRemotes, input.projectRef);
  if (matchedName !== undefined) {
    if (input.requestedLabel === undefined || input.requestedLabel === matchedName) {
      return { ok: true, destination: { kind: "remote", label: matchedName, created: false } };
    }
    const requestedEntry = remoteProjectIdEntries(input.rawRemotes).find(
      (entry) => entry.name === input.requestedLabel,
    );
    return {
      ok: false,
      reason: "label_collision",
      label: input.requestedLabel,
      // No entry under the requested label: it names nothing existing, but
      // `matchedName` already tracks this exact ref under a different name —
      // report that ref as the conflict rather than fabricating one.
      conflictingProjectId: requestedEntry?.projectId ?? input.projectRef,
    };
  }

  // 2. env()-spelled match — hard error, never reused (Decision 1).
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

  // 3. `--remote-label` forces a destination — creating a new block unless
  // the requested name already exists (tracking some other project).
  if (input.requestedLabel !== undefined) {
    const requestedEntry = remoteProjectIdEntries(input.rawRemotes).find(
      (entry) => entry.name === input.requestedLabel,
    );
    if (requestedEntry !== undefined) {
      return {
        ok: false,
        reason: "label_collision",
        label: input.requestedLabel,
        conflictingProjectId: requestedEntry.projectId,
      };
    }
    return {
      ok: true,
      destination: {
        kind: "remote",
        label: legacySanitizeRemoteLabel(input.requestedLabel),
        created: true,
      },
    };
  }

  // 4. Target was named as a branch (name or UUID) — create a block, label
  // falling back to the resolved project ref for a UUID target.
  if (input.targetWasBranch) {
    const label = input.branchLabelCandidate ?? input.projectRef;
    return {
      ok: true,
      destination: { kind: "remote", label: legacySanitizeRemoteLabel(label), created: true },
    };
  }

  // 5. Otherwise: a ref-shaped `--project-ref` or linked-fallback target —
  // write to the config root.
  return { ok: true, destination: { kind: "root" } };
}
