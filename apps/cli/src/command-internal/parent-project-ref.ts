import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import { readProjectRefFile, tempPaths } from "../shared/config/temp-paths.ts";

export type ParentRefResolution =
  | {
      readonly kind: "resolved";
      readonly ref: string;
      /** The `project-ref` ref when it differs from the cached parent; the parent must list it. */
      readonly linkedRef?: string;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" };

/** The `linked-project.json` fields callers read; all but `ref` are present only when non-empty. */
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

/** Parses `linked-project.json`; malformed JSON or a missing `ref` is `None`, never a failure. */
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

/** Reads and parses `<workdir>/supabase/.temp/linked-project.json`; any failure is `None`. */
export const readCachedLinkedProject = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<Option.Option<CachedLinkedProject>> =>
  fs.readFileString(tempPaths(path, workdir).linkedProjectCache).pipe(
    Effect.map(parseCachedLinkedProject),
    Effect.orElseSucceed(() => Option.none<CachedLinkedProject>()),
  );

function parseCachedParentRef(content: string): Option.Option<string> {
  return Option.map(parseCachedLinkedProject(content), (project) => project.ref);
}

function classifyParentCandidates(
  candidates: ReadonlyArray<Option.Option<string>>,
): ParentRefResolution {
  // The first present candidate decides: a malformed higher-priority one stays invalid rather than
  // falling through to a lower-priority project that a mutation could then hit by mistake.
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
 * The linked parent project ref, not the branch's own ref that `resolve` returns right after
 * `link <branch>`: `SUPABASE_PROJECT_ID`, then the `linked-project.json` cache, then `project-ref`.
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

  // An env ref equal to the file's valid ref adds no parent information; drop it so the cache wins.
  // Pattern-valid only, so a garbage env equal to a garbage file stays invalid.
  const envRef =
    Option.isSome(cliSettings.projectId) &&
    Option.isSome(fileRef) &&
    cliSettings.projectId.value === fileRef.value &&
    PROJECT_REF_PATTERN.test(cliSettings.projectId.value)
      ? Option.none<string>()
      : cliSettings.projectId;

  const parent = classifyParentCandidates([envRef, cachedRef, fileRef]);
  if (parent.kind !== "resolved" || Option.isSome(envRef) || Option.isNone(cachedRef))
    return parent;
  const linkedRef = Option.filter(
    fileRef,
    (ref) => ref !== parent.ref && PROJECT_REF_PATTERN.test(ref),
  );
  return Option.isSome(linkedRef) ? { ...parent, linkedRef: linkedRef.value } : parent;
});

/** A hint for a value that looks like a mistyped project ref; empty otherwise. */
export function parentRefTypoHint(value: string): string {
  if (/^[a-z]+$/.test(value)) {
    return `\n  If you meant a project ref: refs are exactly 20 lowercase letters ("${value}" has ${value.length}).`;
  }
  if (/^[A-Za-z]{20}$/.test(value)) {
    return `\n  If you meant a project ref: refs are exactly 20 lowercase letters (try "${value.toLowerCase()}").`;
  }
  return "";
}

/** The branch-name lookup error when no project is linked, shared by `link` and `config diff`. */
export function parentNotLinkedMessage(value: string): string {
  return (
    `Cannot resolve "${value}": it is not a project ref (refs are exactly 20 lowercase letters, ` +
    "like `abcdefghijklmnopqrst`), so it was treated as a branch name — but no project is linked " +
    "to search for branches.\n" +
    "  If it is a branch name, link the parent project first: supabase link --project-ref <parent-ref>" +
    parentRefTypoHint(value)
  );
}

/** The branch-name lookup error for an invalid linked ref, shared by `link` and `config diff`. */
export function parentRefInvalidMessage(value: string): string {
  return `Cannot resolve branch "${value}": the linked project ref is invalid (checked SUPABASE_PROJECT_ID, supabase/.temp/linked-project.json, supabase/.temp/project-ref). Relink the parent project first: supabase link --project-ref <parent-ref>`;
}
