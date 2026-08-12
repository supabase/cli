import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_REF_PATTERN,
} from "../config/legacy-project-ref.service.ts";
import { legacyReadProjectRefFile, legacyTempPaths } from "./legacy-temp-paths.ts";

export type LegacyParentRefResolution =
  | { readonly kind: "resolved"; readonly ref: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" };

/** Best-effort parse of `<workdir>/supabase/.temp/linked-project.json`'s `ref`
 * field — a missing file, unreadable file, malformed JSON, or non-string/empty
 * `ref` all degrade to `None` rather than failing the parent-ref lookup. */
function legacyParseCachedParentRef(content: string): Option.Option<string> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && "ref" in parsed) {
      const ref = (parsed as Record<string, unknown>).ref;
      if (typeof ref === "string" && ref.length > 0) {
        return Option.some(ref);
      }
    }
  } catch {
    // Malformed JSON degrades to "no candidate", same as a missing file.
  }
  return Option.none();
}

function legacyClassifyParentCandidates(
  candidates: ReadonlyArray<Option.Option<string>>,
): LegacyParentRefResolution {
  for (const candidate of candidates) {
    if (Option.isSome(candidate) && PROJECT_REF_PATTERN.test(candidate.value)) {
      return { kind: "resolved", ref: candidate.value };
    }
  }
  return candidates.some(Option.isSome) ? { kind: "invalid" } : { kind: "absent" };
}

/**
 * Resolves the currently-linked PARENT project ref. Deliberately NOT
 * `LegacyProjectRefResolver.resolveOptional`/`resolve` (which resolve the FINAL
 * linked ref): right after linking a branch, that would return the branch's
 * OWN ref, breaking any subsequent command that needs the PARENT (a second
 * `link <other-branch>`, or any `branches` subcommand — CLI-2167 follow-up).
 * Candidate order, first ref-shaped value wins:
 *
 *   1. `SUPABASE_PROJECT_ID` (env, via `LegacyCliConfig`).
 *   2. `ref` in `<workdir>/supabase/.temp/linked-project.json`. KEY INVARIANT:
 *      this file is written by `link`'s own success path only for a REAL
 *      (non-404) project — the branch/404 path leaves it untouched — and
 *      `LegacyLinkedProjectCache.cache` never overwrites an existing file, so
 *      this reliably holds the last real parent project even after
 *      subsequent branch links.
 *   3. `<workdir>/supabase/.temp/project-ref`.
 *
 * If a candidate exists but none is ref-shaped, that's corrupt/stale linked
 * state (`"invalid"`); if none exists at all, the workdir was never linked
 * (`"absent"`).
 */
export const legacyResolveLinkedParentRef = Effect.fnUntraced(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = legacyTempPaths(path, cliConfig.workdir);

  const cachedRef = yield* fs.readFileString(paths.linkedProjectCache).pipe(
    Effect.map(legacyParseCachedParentRef),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const fileRef = yield* legacyReadProjectRefFile(fs, path, cliConfig.workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  return legacyClassifyParentCandidates([cliConfig.projectId, cachedRef, fileRef]);
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
