import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliSettings } from "../config/legacy-cli-settings.service.ts";
import { PROJECT_REF_PATTERN } from "../config/legacy-project-ref.service.ts";
import { legacyFindBranchName } from "./legacy-branch-target.ts";
import {
  type LegacyCachedLinkedProject,
  legacyParseCachedLinkedProject,
} from "./legacy-parent-project-ref.ts";
import { legacyFormatNamedRef, legacySanitizeInlineName } from "./legacy-http-errors.ts";
import { legacyReadProjectRefFile, legacyTempPaths } from "./legacy-temp-paths.ts";

/**
 * Discriminated linked-state result.
 *
 *   - `parentRef` set → the linked ref (`projectRef`) is a BRANCH of a known,
 *     DIFFERENT parent. `branch` is the branch's own resolved name, present
 *     only when the best-effort API lookup found it — "assumed branch, name
 *     unknown" is exactly this shape with `branch` absent.
 *   - `parentRef` absent → a plain project link (or a linked ref with no
 *     evidence of a distinct parent at all).
 *   - `projectName`/`orgSlug`/`orgId` always describe whichever ref is shown
 *     on the "Project:" line (`parentRef ?? projectRef`) — sourced from
 *     `linked-project.json`, so only ever present when that cache is what
 *     supplied the parent candidate.
 */
export type LegacyLinkedState =
  | { readonly linked: false }
  | {
      readonly linked: true;
      readonly projectRef: string;
      readonly projectName?: string;
      readonly orgSlug?: string;
      readonly orgId?: string;
      readonly parentRef?: string;
      readonly branch?: string;
    };

/**
 * Soft "currently linked ref" lookup: env `SUPABASE_PROJECT_ID` → the
 * `<workdir>/supabase/.temp/project-ref` file, never a prompt, never a
 * failure. Loosely based on `LegacyProjectRefResolver.resolveOptional(Option.none())`
 * (reproduced without depending on that service, so `legacyResolveLinkedState`
 * stays usable from a runtime — e.g. `status`'s — that never wires up the
 * resolver) but DELIBERATELY STRICTER than it: both candidates are validated
 * against `PROJECT_REF_PATTERN` here, which `resolveOptional` itself does not
 * do. This is a security boundary, not just a reproduction gap — SECURITY
 * (PR #6168 review): `legacyReadProjectRefFile` follows symlinks and accepts
 * any non-empty content, and `status -o json`/`--output-format json` emits
 * this value verbatim into machine output. A malicious/compromised worktree
 * could symlink `supabase/.temp/project-ref` -> `~/.supabase/access-token`
 * (or any other secret file) to exfiltrate it through CI logs or an agent's
 * captured output. A candidate that does NOT match `PROJECT_REF_PATTERN` is
 * therefore treated exactly as if it were absent — falling through to the
 * next candidate — so non-ref-shaped content (garbage OR a symlinked
 * secret) never reaches ANY output channel, text or machine, and degrades
 * to `Not linked.` / `linked_project: null` instead. Also reports WHICH
 * candidate won, since an env override sitting on top of an unrelated
 * workdir's cache needs different trust rules than the workdir's own file.
 */
const legacyResolveSoftLinkedRef = Effect.fnUntraced(function* () {
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (
    Option.isSome(cliSettings.projectId) &&
    PROJECT_REF_PATTERN.test(cliSettings.projectId.value)
  ) {
    return { ref: cliSettings.projectId, source: "env" as const };
  }
  const fileRef = yield* legacyReadProjectRefFile(fs, path, cliSettings.workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  return {
    ref: Option.filter(fileRef, (ref) => PROJECT_REF_PATTERN.test(ref)),
    source: "file" as const,
  };
});

/**
 * Resolves the current linked-state display (project or branch). Used by
 * `status` to show the linked project/branch without requiring a link
 * beforehand. TS-only surface (CLI-2167 follow-up, no Go counterpart).
 *
 * NEVER FAILS — every step degrades rather than propagating an error:
 *
 *   - Not linked at all → `{ linked: false }`.
 *   - `linked-project.json` CONFIRMS the linked ref is its own `ref` → a
 *     plain project link (its `name`/org fields, when known); zero API calls.
 *   - `linked-project.json` CONFIRMS a genuinely DIFFERENT parent, and the
 *     linked ref came from the `project-ref` FILE → a branch link. Always
 *     renders the branch-linked shape (parent ref + whatever name/org the
 *     cache knows), attempting the best-effort branch-name lookup
 *     ({@link legacyFindBranchName}) and degrading to the bare
 *     "assumed branch, name unknown" shape — NOT to a plain/bare project
 *     line — on any acquisition or API failure. This is the fix for the real
 *     bug this feature shipped to fix: the user must still see they're on a
 *     branch even when the lookup can't run (no token, offline, API error).
 *     The cache lifecycle invariants `link`/`legacyResolveLinkedParentRef`
 *     maintain are what let a file-sourced ref trust the cache through a
 *     lookup failure.
 *   - Same cache/ref divergence, but the linked ref came from `SUPABASE_PROJECT_ID`
 *     (env) → the cache belongs to the WORKDIR, not necessarily to whatever
 *     `SUPABASE_PROJECT_ID` happens to point at (e.g. workdir linked to
 *     project A, `SUPABASE_PROJECT_ID=B` for an unrelated project B) — an env
 *     override carries none of those invariants. The lookup still runs, but
 *     the parent claim requires it to have POSITIVELY found `B` among `A`'s
 *     branches; on no-match, failure, or timeout, degrade all the way to the
 *     plain `{ linked: true, projectRef }` shape (no parent, no branch line,
 *     no cache-sourced name/org) rather than asserting "B is a branch of A"
 *     on nothing but the cache's mere presence (PR #6168 review). An
 *     env-override CI workflow that DOES link a real branch still renders
 *     correctly, since that lookup positively confirms.
 *   - No cache at all (missing/unreadable/malformed) → the plain
 *     `{ linked: true, projectRef }` shape, with ZERO API calls (PR #6168
 *     review). `legacyResolveLinkedParentRef`'s own env/file chain is now
 *     ALWAYS self-referential here (its cache candidate only ever
 *     participates when a link has actually completed — see its doc
 *     comment), so querying it could only ever match the linked ref's own
 *     DEFAULT branch row (misrendering an ordinary project as "a branch of
 *     itself") or 403 on the real platform when the linked ref genuinely is
 *     a branch — there is no positive-confirmation case left to attempt.
 */
export const legacyResolveLinkedState = Effect.fnUntraced(function* () {
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const soft = yield* legacyResolveSoftLinkedRef();
  const linkedRef = soft.ref;
  if (Option.isNone(linkedRef)) {
    return { linked: false } as const;
  }

  const paths = legacyTempPaths(path, cliSettings.workdir);
  const cached = yield* fs.readFileString(paths.linkedProjectCache).pipe(
    Effect.map(legacyParseCachedLinkedProject),
    Effect.orElseSucceed(() => Option.none<LegacyCachedLinkedProject>()),
  );

  if (Option.isSome(cached)) {
    const cacheFields = {
      ...(cached.value.name === undefined ? {} : { projectName: cached.value.name }),
      ...(cached.value.organizationSlug === undefined
        ? {}
        : { orgSlug: cached.value.organizationSlug }),
      ...(cached.value.organizationId === undefined ? {} : { orgId: cached.value.organizationId }),
    };

    if (cached.value.ref === linkedRef.value) {
      // The cache confirms the linked ref IS the parent — a plain project link.
      return { linked: true, projectRef: linkedRef.value, ...cacheFields } as const;
    }

    // The cache names a genuinely DIFFERENT parent than the linked ref.
    const parentRef = cached.value.ref;
    const branch = yield* legacyFindBranchName(parentRef, linkedRef.value, {
      spinnerLabel: "Checking linked branch...",
    });
    if (branch === undefined && soft.source === "env") {
      // An env override's lookup didn't POSITIVELY confirm a branch, and the
      // cache carries none of the file-sourced trust invariants (it belongs
      // to the WORKDIR, not necessarily to whatever `SUPABASE_PROJECT_ID`
      // points at) — make no parent claim at all (PR #6168 review).
      return { linked: true, projectRef: linkedRef.value } as const;
    }
    // Either file-sourced (the cache's trust invariants apply) or
    // env-sourced with a POSITIVE lookup confirmation — always the
    // branch-linked shape, degrading only the `branch` name.
    return {
      linked: true,
      projectRef: linkedRef.value,
      parentRef,
      ...cacheFields,
      ...(branch === undefined ? {} : { branch }),
    } as const;
  }

  // No cache at all — render the plain shape with ZERO API calls (PR #6168
  // review). With `legacyResolveLinkedParentRef`'s own fix (its cache
  // candidate only participates when a link actually completed), its
  // env/file chain is now ALWAYS self-referential here — it's the exact same
  // soft linked-ref chain `legacyResolveSoftLinkedRef` above just read — so
  // querying it could only ever (a) match the linked ref's own DEFAULT
  // branch row when it's an ordinary parent, misrendering the project as "a
  // branch of itself", or (b) 403 on the real platform when the linked ref
  // genuinely is a branch (branches endpoints are parent-scoped). There is
  // no positive-confirmation case left to attempt.
  return { linked: true, projectRef: linkedRef.value } as const;
});

// Every string in this human-text block is untrusted display data — not just
// API-derived names/org slug/id, but the refs themselves. `projectRef` is now
// pattern-validated upstream (`legacyResolveSoftLinkedRef`, PR #6168 review —
// closes the `.temp/project-ref` symlink/token-exfiltration vector), but
// `parentRef` (`linked-project.json`'s `ref`, via `legacyParseCachedLinkedProject`)
// is still only validated as a non-empty string — a malicious/corrupted cache
// file could inject ANSI/OSC/newline controls into `supabase status` stdout
// via the parent ref itself, not just a branch/org name. Sanitize every
// rendered value regardless — defense-in-depth for `projectRef` too, since a
// display-layer guarantee shouldn't depend on remembering every upstream
// validation site. Machine payloads (`-o`/`--output-format`) stay
// data-faithful — JSON/YAML/TOML/env encoding already neutralizes control
// chars there; this sanitization is for the human text block only.
function legacyFormatOrgLabel(slug: string | undefined, id: string | undefined): string {
  if (slug !== undefined && id !== undefined) {
    return slug === id
      ? legacySanitizeInlineName(slug)
      : `${legacySanitizeInlineName(slug)} (${legacySanitizeInlineName(id)})`;
  }
  return legacySanitizeInlineName(slug ?? id ?? "");
}

/**
 * Pure formatter for `LegacyLinkedState` — the full multi-line block,
 * including its trailing newline. Not linked stays a single plain line (no
 * header block, unchanged from the prior single-line format):
 *
 * ```
 * Not linked.
 * ```
 *
 * Linked renders a "Linked Project:" header with up to 3 indented lines —
 * `Org:` only when at least one of `orgSlug`/`orgId` is known, `Project:`
 * always, `Branch:` only in the branch-linked state (even when the branch's
 * own name is unresolved, the user must still see they're on a branch):
 *
 * ```
 * Linked Project:
 *   Org: <org_slug> (<org_id>)
 *   Project: <project_name> (<parent_or_project_ref>)
 *   Branch: <branch_name> (<branch_ref>)
 * ```
 */
export function legacyFormatLinkedStateBlock(state: LegacyLinkedState): string {
  if (!state.linked) {
    return "Not linked.\n";
  }

  const lines: Array<string> = ["Linked Project:"];

  if (state.orgSlug !== undefined || state.orgId !== undefined) {
    lines.push(`  Org: ${legacyFormatOrgLabel(state.orgSlug, state.orgId)}`);
  }

  const projectRef = state.parentRef ?? state.projectRef;
  lines.push(`  Project: ${legacyFormatNamedRef(state.projectName, projectRef)}`);

  if (state.parentRef !== undefined) {
    lines.push(`  Branch: ${legacyFormatNamedRef(state.branch, state.projectRef)}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Additive flat snake_case keys for a Go machine-format payload
 * (`-o env|json|yaml|toml`) — merge into the format's own key/value map
 * AFTER its existing keys so their order is undisturbed (irrelevant for
 * `-o env`/`-o json`, which sort keys anyway; preserved for `-o yaml`/`-o toml`,
 * which don't). `encodeEnv`'s `toEnvKey` upper-cases these unchanged, so
 * `linked_project_ref` becomes `LINKED_PROJECT_REF`, etc. Empty when not
 * linked — absence of every key IS "not linked" for these formats, not a
 * `linked: false`/empty-string entry. Degraded branch-linked state still
 * emits every field it knows (`linked_project_ref`, `linked_parent_project_ref`,
 * `linked_project_name`, org fields) — only `linked_branch` is absent. TS-only
 * QoL (CLI-2167 follow-up, no Go counterpart), letting an agent driving a
 * machine format discover the linked project/branch without a separate
 * `link`/`branches` call.
 */
export function legacyLinkedStateGoFields(
  state: LegacyLinkedState,
): Readonly<Record<string, string>> {
  if (!state.linked) return {};
  return {
    linked_project_ref: state.projectRef,
    ...(state.projectName === undefined ? {} : { linked_project_name: state.projectName }),
    ...(state.orgSlug === undefined ? {} : { linked_org_slug: state.orgSlug }),
    ...(state.orgId === undefined ? {} : { linked_org_id: state.orgId }),
    ...(state.branch === undefined ? {} : { linked_branch: state.branch }),
    ...(state.parentRef === undefined ? {} : { linked_parent_project_ref: state.parentRef }),
  };
}

/** The `linked_project` shape merged into a TS `--output-format json`/`stream-json`
 * structured success payload — see {@link legacyLinkedStateGoFields} for the
 * Go-machine-format counterpart. */
export interface LegacyLinkedStateJsonField {
  readonly project_ref: string;
  readonly branch?: string;
  readonly parent_project_ref?: string;
  readonly project_name?: string;
  readonly org_slug?: string;
  readonly org_id?: string;
}

/**
 * Additive nested field for a TS `--output-format json`/`stream-json`
 * structured success payload: `null` when not linked, so its mere presence
 * never collides with an existing top-level key. TS-only QoL (CLI-2167
 * follow-up, no Go counterpart).
 */
export function legacyLinkedStateJsonField(
  state: LegacyLinkedState,
): LegacyLinkedStateJsonField | null {
  if (!state.linked) return null;
  return {
    project_ref: state.projectRef,
    ...(state.branch === undefined ? {} : { branch: state.branch }),
    ...(state.parentRef === undefined ? {} : { parent_project_ref: state.parentRef }),
    ...(state.projectName === undefined ? {} : { project_name: state.projectName }),
    ...(state.orgSlug === undefined ? {} : { org_slug: state.orgSlug }),
    ...(state.orgId === undefined ? {} : { org_id: state.orgId }),
  };
}
