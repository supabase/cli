import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import { findBranchName } from "./branch-target.ts";
import { type CachedLinkedProject, parseCachedLinkedProject } from "./parent-project-ref.ts";
import { formatNamedRef, sanitizeInlineName } from "./http-errors.ts";
import { readProjectRefFile, tempPaths } from "./temp-paths.ts";

/**
 * Discriminated linked-state result.
 *
 * - `parentRef` set: the linked ref (`projectRef`) is a branch of a known,
 *   different parent. `branch` is the branch's resolved name, present only
 *   when the best-effort lookup found it.
 * - `parentRef` absent: a plain project link, or a linked ref with no
 *   evidence of a distinct parent.
 * - `projectName`/`orgSlug`/`orgId` describe whichever ref is shown on the
 *   "Project:" line (`parentRef ?? projectRef`), present only when
 *   `linked-project.json` supplied the parent candidate.
 */
export type LinkedState =
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
 * Soft lookup of the currently linked ref: env `SUPABASE_PROJECT_ID`, else the
 * `<workdir>/supabase/.temp/project-ref` file. Never prompts or fails, and does not depend on
 * `ProjectRefResolver`, so runtimes like `status` can use it without wiring that resolver up.
 *
 * Candidates must match `PROJECT_REF_PATTERN`: the value is echoed verbatim by `status -o json`
 * and the file read follows symlinks, so an unvalidated value could leak a secret file's contents.
 * Reports which source won, since the env override and the cache file carry different trust.
 */
const resolveSoftLinkedRef = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (
    Option.isSome(cliSettings.projectId) &&
    PROJECT_REF_PATTERN.test(cliSettings.projectId.value)
  ) {
    return { ref: cliSettings.projectId, source: "env" as const };
  }
  const fileRef = yield* readProjectRefFile(fs, path, cliSettings.workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  return {
    ref: Option.filter(fileRef, (ref) => PROJECT_REF_PATTERN.test(ref)),
    source: "file" as const,
  };
});

/**
 * Resolves the current linked-state display (project or branch) for
 * `status`, without requiring a link. Never fails — every step degrades
 * rather than propagating an error:
 *
 * - Not linked → `{ linked: false }`.
 * - The cache confirms the linked ref is its own parent → a plain project
 *   link, zero API calls.
 * - The cache names a different parent and the ref came from the
 *   `project-ref` file → a branch link. Attempts the best-effort
 *   {@link findBranchName} lookup, but degrades to "assumed branch, name
 *   unknown" rather than a plain line on any failure, so the user still sees
 *   they're on a branch when the lookup can't run.
 * - Same divergence, but the ref came from `SUPABASE_PROJECT_ID` (env) — the
 *   cache belongs to the workdir, not necessarily to what the env var points
 *   at, so the branch claim additionally requires the lookup to positively
 *   confirm it; otherwise it degrades to the plain `{ linked: true,
 *   projectRef }` shape.
 * - No cache at all → the plain shape, with zero API calls.
 */
export const resolveLinkedState = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const soft = yield* resolveSoftLinkedRef();
  const linkedRef = soft.ref;
  if (Option.isNone(linkedRef)) {
    return { linked: false } as const;
  }

  const paths = tempPaths(path, cliSettings.workdir);
  const cached = yield* fs.readFileString(paths.linkedProjectCache).pipe(
    Effect.map(parseCachedLinkedProject),
    Effect.orElseSucceed(() => Option.none<CachedLinkedProject>()),
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
      // The cache confirms the linked ref is the parent — a plain project link.
      return { linked: true, projectRef: linkedRef.value, ...cacheFields } as const;
    }

    // The cache names a different parent than the linked ref.
    const parentRef = cached.value.ref;
    const branch = yield* findBranchName(parentRef, linkedRef.value, {
      spinnerLabel: "Checking linked branch...",
    });
    if (branch === undefined && soft.source === "env") {
      // An env override's lookup didn't confirm a branch, and the cache may
      // belong to an unrelated project — make no parent claim at all.
      return { linked: true, projectRef: linkedRef.value } as const;
    }
    // File-sourced, or env-sourced with a confirmed lookup: always render
    // the branch-linked shape, degrading only the `branch` name.
    return {
      linked: true,
      projectRef: linkedRef.value,
      parentRef,
      ...cacheFields,
      ...(branch === undefined ? {} : { branch }),
    } as const;
  }

  // No cache at all: render the plain shape with zero API calls. Querying
  // `resolveLinkedParentRef` here would only match the ref's own default
  // branch (misrendering it as "a branch of itself") or 403 when it
  // genuinely is a branch — there's no positive-confirmation case to attempt.
  return { linked: true, projectRef: linkedRef.value } as const;
});

// Every rendered string here is untrusted display data, including the refs
// themselves (`parentRef` from `linked-project.json` is only validated as
// non-empty, so a corrupted cache file could inject terminal control
// sequences). Sanitize unconditionally rather than relying on upstream
// validation. Machine payloads (`-o`/`--output-format`) skip this — their own
// encoders already neutralize control chars.
function formatOrgLabel(slug: string | undefined, id: string | undefined): string {
  if (slug !== undefined && id !== undefined) {
    return slug === id
      ? sanitizeInlineName(slug)
      : `${sanitizeInlineName(slug)} (${sanitizeInlineName(id)})`;
  }
  return sanitizeInlineName(slug ?? id ?? "");
}

/**
 * Pure formatter for `LinkedState` — the full multi-line block, including its
 * trailing newline. Not linked renders a single plain line:
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
export function formatLinkedStateBlock(state: LinkedState): string {
  if (!state.linked) {
    return "Not linked.\n";
  }

  const lines: Array<string> = ["Linked Project:"];

  if (state.orgSlug !== undefined || state.orgId !== undefined) {
    lines.push(`  Org: ${formatOrgLabel(state.orgSlug, state.orgId)}`);
  }

  const projectRef = state.parentRef ?? state.projectRef;
  lines.push(`  Project: ${formatNamedRef(state.projectName, projectRef)}`);

  if (state.parentRef !== undefined) {
    lines.push(`  Branch: ${formatNamedRef(state.branch, state.projectRef)}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Additive flat snake_case keys for the `-o env|json|yaml|toml` machine
 * format, merged into the format's own key/value map after its existing keys
 * (order matters for `-o yaml`/`-o toml`; env/json sort keys anyway).
 * `encodeEnv` upper-cases these unchanged (`linked_project_ref` →
 * `LINKED_PROJECT_REF`). Empty when not linked — absence of every key is
 * what signals "not linked" for these formats. A degraded branch-linked
 * state still emits every field it knows; only `linked_branch` is absent.
 */
export function linkedStateGoFields(state: LinkedState): Readonly<Record<string, string>> {
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

/**
 * The `linked_project` shape merged into a `--output-format json`/
 * `stream-json` structured success payload. See {@link linkedStateGoFields}
 * for the `-o` machine-format counterpart.
 */
export interface LinkedStateJsonField {
  readonly project_ref: string;
  readonly branch?: string;
  readonly parent_project_ref?: string;
  readonly project_name?: string;
  readonly org_slug?: string;
  readonly org_id?: string;
}

/**
 * Additive nested field for a `--output-format json`/`stream-json` structured
 * success payload: `null` when not linked, so its mere presence never
 * collides with an existing top-level key.
 */
export function linkedStateJsonField(state: LinkedState): LinkedStateJsonField | null {
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
