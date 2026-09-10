import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { ProjectRefResolver, PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import { readProjectRefFile, tempPaths } from "./temp-paths.ts";

export type ParentRefResolution =
  | { readonly kind: "resolved"; readonly ref: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" };

/**
 * The subset of `<workdir>/supabase/.temp/linked-project.json` callers care about: the
 * parent project's `ref`, `name`, `organization_slug`, and `organization_id`. The latter
 * three are optional, present only when the cache holds a non-empty string value.
 */
export interface CachedLinkedProject {
  readonly ref: string;
  readonly name?: string;
  readonly organizationSlug?: string;
  readonly organizationId?: string;
}

function readOptionalCacheString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Best-effort parse of `<workdir>/supabase/.temp/linked-project.json`'s `ref` (and, when
 * present, `name`/`organization_slug`/`organization_id`) fields. A missing/unreadable file,
 * malformed JSON, or non-string/empty `ref` all degrade to `None` rather than failing.
 */
export function parseCachedLinkedProject(content: string): Option.Option<CachedLinkedProject> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) {
      const ref = parsed.ref;
      if (typeof ref === "string" && ref.length > 0) {
        const name = readOptionalCacheString(parsed, "name");
        const organizationSlug = readOptionalCacheString(parsed, "organization_slug");
        const organizationId = readOptionalCacheString(parsed, "organization_id");
        return Option.some({
          ref,
          ...(name === undefined ? {} : { name }),
          ...(organizationSlug === undefined ? {} : { organizationSlug }),
          ...(organizationId === undefined ? {} : { organizationId }),
        });
      }
    }
  } catch {
    // Malformed JSON degrades to "no candidate", same as a missing file.
  }
  return Option.none();
}

function parseCachedParentRef(content: string): Option.Option<string> {
  return Option.map(parseCachedLinkedProject(content), (project) => project.ref);
}

function classifyParentCandidates(
  candidates: ReadonlyArray<Option.Option<string>>,
): ParentRefResolution {
  // The first present candidate decides: a malformed higher-priority candidate (e.g. a
  // typo'd SUPABASE_PROJECT_ID) hard-classifies as invalid rather than falling through to a
  // lower-priority project, which could otherwise run a mutation against the wrong project.
  for (const candidate of candidates) {
    if (Option.isSome(candidate)) {
      return PROJECT_REF_PATTERN.test(candidate.value)
        ? { kind: "resolved", ref: candidate.value }
        : { kind: "invalid" };
    }
  }
  return { kind: "absent" };
}

/**
 * Resolves the currently-linked PARENT project ref, not the branch's own ref that
 * `ProjectRefResolver.resolveOptional`/`resolve` would return right after `link <branch>`.
 * The first present candidate wins, in order: `SUPABASE_PROJECT_ID` env, the
 * `linked-project.json` cache, then the temp `project-ref` file. A malformed candidate
 * hard-classifies as `"invalid"` rather than falling through to a lower-priority one; no
 * candidate at all means the workdir was never linked (`"absent"`).
 */
export const resolveLinkedParentRef = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = tempPaths(path, cliSettings.workdir);

  const fileRef = yield* readProjectRefFile(fs, path, cliSettings.workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  // The cache alone isn't proof a link completed — `link` writes it on both success and
  // failure — so only read it as parent recovery when the temp file confirms a link happened.
  const cachedRef = Option.isSome(fileRef)
    ? yield* fs.readFileString(paths.linkedProjectCache).pipe(
        Effect.map(parseCachedParentRef),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
    : Option.none<string>();

  // An env candidate that merely restates the file candidate's own (valid) value carries no
  // parent information; drop it so the cache gets a chance to win instead. Restricted to
  // pattern-valid values so a garbage env equal to a garbage file still hard-classifies as
  // invalid below instead of sneaking past to the cache.
  const envRef =
    Option.isSome(cliSettings.projectId) &&
    Option.isSome(fileRef) &&
    cliSettings.projectId.value === fileRef.value &&
    PROJECT_REF_PATTERN.test(cliSettings.projectId.value)
      ? Option.none<string>()
      : cliSettings.projectId;

  return classifyParentCandidates([envRef, cachedRef, fileRef]);
});

/**
 * Project-ref resolver for the PARENT-SCOPED `branches` command family: after `link <branch>`,
 * the temp `project-ref` file holds the branch's own ref, but branch-management endpoints
 * return 403 for branch refs, so this resolves the parent instead. An explicit `flagValue`
 * always wins; otherwise it prefers `resolveLinkedParentRef`'s cached parent, falling back to
 * `resolver.resolve` unchanged when no parent is resolvable.
 */
export const resolveParentScopedProjectRef = Effect.fnUntraced(function* (
  flagValue: Option.Option<string>,
) {
  const resolver = yield* ProjectRefResolver;

  if (Option.isSome(flagValue) && flagValue.value.length > 0) {
    return yield* resolver.resolve(flagValue);
  }

  const parent = yield* resolveLinkedParentRef();
  if (parent.kind === "resolved") {
    return parent.ref;
  }

  return yield* resolver.resolve(Option.none());
});

/**
 * A value made entirely of lowercase letters (but not 20 of them, or it would already have
 * been treated as a ref) is a plausible ref typo. Appended to both {@link parentNotLinkedMessage}
 * and `link`'s own branch-not-found message.
 */
export function parentRefTypoHint(value: string): string {
  if (!/^[a-z]+$/.test(value)) return "";
  return `\n  If you meant a project ref: refs are exactly 20 lowercase letters ("${value}" has ${value.length}).`;
}

/**
 * Shared "no project is linked to search for branches" message, produced when
 * {@link resolveLinkedParentRef} reports `"absent"` for a non-ref-shaped
 * `--project-ref`/positional value. Used by both `link` and `config diff`.
 */
export function parentNotLinkedMessage(value: string): string {
  return (
    `Cannot resolve "${value}": it is not a project ref (refs are exactly 20 lowercase letters, ` +
    "like `abcdefghijklmnopqrst`), so it was treated as a branch name — but no project is linked " +
    "to search for branches.\n" +
    "  If it is a branch name, link the parent project first: supabase link --project-ref <parent-ref>" +
    parentRefTypoHint(value)
  );
}

/**
 * Shared "the linked project ref is invalid" message, produced when
 * {@link resolveLinkedParentRef} reports `"invalid"` for a non-ref-shaped
 * `--project-ref`/positional value. Used by both `link` and `config diff`.
 */
export function parentRefInvalidMessage(value: string): string {
  return `Cannot resolve branch "${value}": the linked project ref is invalid (checked SUPABASE_PROJECT_ID, supabase/.temp/linked-project.json, supabase/.temp/project-ref). Relink the parent project first: supabase link --project-ref <parent-ref>`;
}
