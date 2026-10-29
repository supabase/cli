import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import { type CachedLinkedProject, readLinkSnapshotSoft } from "../shared/config/link-snapshot.ts";

export type ParentRefResolution =
  | {
      readonly kind: "resolved";
      readonly ref: string;
      /** The linked ref when it differs from the recorded parent; the parent must list it. */
      readonly linkedRef?: string;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" };

/** The parent project the checkout's link records; any read failure is `None`. */
export const readCachedLinkedProject = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<Option.Option<CachedLinkedProject>> =>
  readLinkSnapshotSoft(fs, path, workdir).pipe(Effect.map((snapshot) => snapshot.parent));

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
 * `link <branch>`: `SUPABASE_PROJECT_ID`, then the link's recorded parent, then the linked ref.
 */
export const resolveLinkedParentRef = Effect.fn("ParentProjectRef.resolveLinked")(function* () {
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const snapshot = yield* readLinkSnapshotSoft(fs, path, cliSettings.workdir);
  const linkedRef = snapshot.ref;

  // The recorded parent alone isn't proof a link completed — legacy `link` writes it on both
  // success and failure — so it counts only when the linked ref confirms the link.
  const cachedRef = Option.isSome(linkedRef)
    ? Option.map(snapshot.parent, (parent) => parent.ref)
    : Option.none<string>();

  // An env ref equal to the valid linked ref adds no parent information; drop it so the recorded
  // parent wins. Pattern-valid only, so a garbage env equal to a garbage link stays invalid.
  const envRef =
    Option.isSome(cliSettings.projectId) &&
    Option.isSome(linkedRef) &&
    cliSettings.projectId.value === linkedRef.value &&
    PROJECT_REF_PATTERN.test(cliSettings.projectId.value)
      ? Option.none<string>()
      : cliSettings.projectId;

  const parent = classifyParentCandidates([envRef, cachedRef, linkedRef]);
  if (parent.kind !== "resolved" || Option.isSome(envRef) || Option.isNone(cachedRef))
    return parent;
  const branchRef = Option.filter(
    linkedRef,
    (ref) => ref !== parent.ref && PROJECT_REF_PATTERN.test(ref),
  );
  return Option.isSome(branchRef) ? { ...parent, linkedRef: branchRef.value } : parent;
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
