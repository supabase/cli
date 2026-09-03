import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliSettings } from "../config/legacy-cli-settings.service.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_REF_PATTERN,
} from "../config/legacy-project-ref.service.ts";
import { legacyReadProjectRefFile, legacyTempPaths } from "./legacy-temp-paths.ts";

export type LegacyParentRefResolution =
  | { readonly kind: "resolved"; readonly ref: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" };

/** The subset of `<workdir>/supabase/.temp/linked-project.json` callers care
 * about: the parent project's `ref`, its `name`, and its
 * `organization_slug`/`organization_id` — all optional, present only when the
 * cache carries a usable (non-empty string) value for each. */
export interface LegacyCachedLinkedProject {
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

/** Best-effort parse of `<workdir>/supabase/.temp/linked-project.json`'s `ref`
 * (and, when present, `name`/`organization_slug`/`organization_id`) fields —
 * a missing file, unreadable file, malformed JSON, or non-string/empty `ref`
 * all degrade to `None` rather than failing the caller. */
export function legacyParseCachedLinkedProject(
  content: string,
): Option.Option<LegacyCachedLinkedProject> {
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

function legacyParseCachedParentRef(content: string): Option.Option<string> {
  return Option.map(legacyParseCachedLinkedProject(content), (project) => project.ref);
}

function legacyClassifyParentCandidates(
  candidates: ReadonlyArray<Option.Option<string>>,
): LegacyParentRefResolution {
  // The FIRST PRESENT candidate decides (PR #6168 review): a present-but-
  // malformed higher-priority candidate (a typo'd SUPABASE_PROJECT_ID) must
  // hard-classify as invalid rather than silently falling through to a
  // lower-priority project — otherwise a mutation could run against the
  // previously linked project the user explicitly tried to override away
  // from. This also restores the pre-CLI-2167 resolver's env validation.
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
 * Resolves the currently-linked PARENT project ref. Deliberately NOT
 * `LegacyProjectRefResolver.resolveOptional`/`resolve` (which resolve the FINAL
 * linked ref): right after linking a branch, that would return the branch's
 * OWN ref, breaking any subsequent command that needs the PARENT (a second
 * `link <other-branch>`, or any `branches` subcommand — CLI-2167 follow-up).
 * Candidate order; the FIRST PRESENT candidate decides — valid resolves,
 * malformed hard-classifies as `"invalid"` (never silently skipped):
 *
 *   1. `SUPABASE_PROJECT_ID` (env, via `LegacyCliSettings`) — UNLESS it merely
 *      RESTATES candidate 3's own value. A CI workflow commonly exports
 *      `SUPABASE_PROJECT_ID=<branch-ref>` right after `link <branch>`
 *      (mirroring what `project-ref` already holds) — that adds no parent
 *      information, so treat it exactly as absent and let the cache (the
 *      REAL parent) win instead of self-referentially "resolving" to the
 *      branch's own ref again (PR #6168 review). A genuinely different env
 *      value (a deliberate override to a DIFFERENT project) still wins
 *      outright, same as always.
 *   2. `ref` in `<workdir>/supabase/.temp/linked-project.json` — ONLY when
 *      candidate 3 below yielded a value. KEY INVARIANT: the cache alone is
 *      NOT proof of a completed link — `link`'s handler writes it via
 *      `Effect.ensuring` on BOTH success and failure (mirroring Go's
 *      `PersistentPostRun`), so a FAILED `link --project-ref B` can leave a
 *      cache entry for a `B` that was never actually linked (`getProject`
 *      returned 200 — e.g. for a paused project — but a later link step
 *      failed before `project-ref` itself was ever written). It's a
 *      telemetry artifact, not linked-state evidence; it's trusted only as
 *      PARENT RECOVERY for a link that has already actually happened, which
 *      candidate 3 is exactly the proof of (PR #6168 review).
 *   3. `<workdir>/supabase/.temp/project-ref`.
 *
 * A present-but-malformed first candidate is corrupt/stale linked state or a
 * typo'd override (`"invalid"` — callers surface an error rather than acting
 * on a lower-priority project); if no candidate exists at all, the workdir
 * was never linked (`"absent"`).
 */
export const legacyResolveLinkedParentRef = Effect.fnUntraced(function* () {
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = legacyTempPaths(path, cliSettings.workdir);

  const fileRef = yield* legacyReadProjectRefFile(fs, path, cliSettings.workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const cachedRef = Option.isSome(fileRef)
    ? yield* fs.readFileString(paths.linkedProjectCache).pipe(
        Effect.map(legacyParseCachedParentRef),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
    : Option.none<string>();

  // Dedup rule (PR #6168 review): an env candidate that merely restates the
  // file candidate's own (valid) value carries no parent information — drop
  // it so the cache gets a chance to win instead. Restricted to pattern-valid
  // values so a garbage env that happens to equal a garbage file still
  // hard-classifies as invalid below instead of sneaking past to the cache.
  const envRef =
    Option.isSome(cliSettings.projectId) &&
    Option.isSome(fileRef) &&
    cliSettings.projectId.value === fileRef.value &&
    PROJECT_REF_PATTERN.test(cliSettings.projectId.value)
      ? Option.none<string>()
      : cliSettings.projectId;

  return legacyClassifyParentCandidates([envRef, cachedRef, fileRef]);
});

/**
 * Project-ref resolver for the PARENT-SCOPED `branches` command family. TS-only
 * divergence (CLI-2167 follow-up, no Go counterpart): after `supabase link
 * <branch>`, `supabase/.temp/project-ref` holds the BRANCH's own ref, and the
 * Management API returns 403 for branch refs on every branches-management
 * endpoint (they're parent-project-scoped). Every `branches` subcommand must
 * keep resolving the PARENT, not whatever `link` last wrote there.
 *
 * Semantics:
 *
 *   1. `flagValue` present and non-empty → delegate to
 *      `LegacyProjectRefResolver.resolve(flagValue)` unchanged (an explicit
 *      `--project-ref` always wins, with its existing validation/error
 *      behavior reproduced exactly).
 *   2. Otherwise, run `legacyResolveLinkedParentRef`:
 *      - `"resolved"` → return that ref. This is the fix: it prefers the
 *        cached parent (env / `linked-project.json`) over a branch ref sitting
 *        in `project-ref`.
 *      - `"invalid"` or `"absent"` → fall through to
 *        `LegacyProjectRefResolver.resolve(Option.none())`, so the existing
 *        env/prompt/not-linked error behavior is reproduced exactly — no new
 *        error types; the error channel is identical to `resolver.resolve`.
 *
 * No-op property: when linked to a real (non-branch) project, the cache and
 * the `project-ref` file hold the same ref, so every result here is identical
 * to calling `resolver.resolve` directly today. Behavior only changes in the
 * previously-403ing state where `project-ref` holds a branch ref.
 */
export const legacyResolveParentScopedProjectRef = Effect.fnUntraced(function* (
  flagValue: Option.Option<string>,
) {
  const resolver = yield* LegacyProjectRefResolver;

  if (Option.isSome(flagValue) && flagValue.value.length > 0) {
    return yield* resolver.resolve(flagValue);
  }

  const parent = yield* legacyResolveLinkedParentRef();
  if (parent.kind === "resolved") {
    return parent.ref;
  }

  return yield* resolver.resolve(Option.none());
});

/**
 * A value made entirely of lowercase letters (but not 20 of them, or it would
 * already have been treated as a ref) is a plausible ref typo. Appended to
 * both {@link legacyParentNotLinkedMessage} and `link`'s own
 * branch-not-found message — shared by every command that resolves a branch
 * name/UUID under the currently-linked PARENT project (CLI-2167).
 */
export function legacyParentRefTypoHint(value: string): string {
  if (!/^[a-z]+$/.test(value)) return "";
  return `\n  If you meant a project ref: refs are exactly 20 lowercase letters ("${value}" has ${value.length}).`;
}

/**
 * Shared "no project is linked to search for branches" message, produced when
 * {@link legacyResolveLinkedParentRef} reports `"absent"` for a non-ref-shaped
 * `--project-ref`/positional value. Used by both `link` and `config diff`
 * (Hoist Before You Duplicate — ≥2 commands across families).
 */
export function legacyParentNotLinkedMessage(value: string): string {
  return (
    `Cannot resolve "${value}": it is not a project ref (refs are exactly 20 lowercase letters, ` +
    "like `abcdefghijklmnopqrst`), so it was treated as a branch name — but no project is linked " +
    "to search for branches.\n" +
    "  If it is a branch name, link the parent project first: supabase link --project-ref <parent-ref>" +
    legacyParentRefTypoHint(value)
  );
}

/**
 * Shared "the linked project ref is invalid" message, produced when
 * {@link legacyResolveLinkedParentRef} reports `"invalid"` for a non-ref-shaped
 * `--project-ref`/positional value. Used by both `link` and `config diff`
 * (Hoist Before You Duplicate — ≥2 commands across families).
 */
export function legacyParentRefInvalidMessage(value: string): string {
  return `Cannot resolve branch "${value}": the linked project ref is invalid (checked SUPABASE_PROJECT_ID, supabase/.temp/linked-project.json, supabase/.temp/project-ref). Relink the parent project first: supabase link --project-ref <parent-ref>`;
}
