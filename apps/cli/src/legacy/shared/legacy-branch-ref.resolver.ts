import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect } from "effect";

import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";

/**
 * Project ref pattern shared by every Management-API endpoint that accepts a
 * 20-lowercase-letter project reference.
 */
export const LEGACY_BRANCH_PROJECT_REF_PATTERN = /^[a-z]{20}$/;

/**
 * Permissive UUID pattern (any 8-4-4-4-12 hex sequence) — accepts any RFC 4122
 * variant including v6/v7 and version 0, matching the established liberal
 * acceptance rather than the v1–v5 + variant-1 subset.
 */
export const LEGACY_BRANCH_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-family error mapping for {@link legacyResolveBranchProjectRef}: each
 * caller keeps its own tagged error classes (built with `mapLegacyHttpError`)
 * so error identities, messages, and actionability stay family-owned.
 */
export interface LegacyBranchRefResolveMappers<EGet, EFind> {
  /** Maps a `GET /v1/branches/{branch_id}` (UUID lookup) failure. */
  readonly mapGetError: (cause: SupabaseApiError) => Effect.Effect<never, EGet>;
  /** Maps a `GET /v1/projects/{ref}/branches/{name}` (name lookup) failure. */
  readonly mapFindError: (cause: SupabaseApiError) => Effect.Effect<never, EFind>;
}

/**
 * Resolves an arbitrary branch identifier to its project ref:
 *
 * 1. If the input matches `^[a-z]{20}$`, it's already a project ref — return as-is.
 * 2. Else if the input is a UUID, call `V1GetABranchConfig` (`GET /v1/branches/{id}`)
 *    and return `JSON200.ref`.
 * 3. Otherwise treat as a branch name under the linked project ref: call
 *    `V1GetABranch` (`GET /v1/projects/{ref}/branches/{name}`) and return
 *    `JSON200.project_ref`.
 *
 * The parent project ref is required only for path 3, so it may be passed
 * lazily as an Effect — it is evaluated exactly then, never for a ref-shaped
 * or UUID input. That keeps `--project-ref <uuid>` working in an unlinked
 * directory: the UUID endpoint does not use a parent ref, so requiring one
 * up front would fail invocations the API itself can serve.
 */
export function legacyResolveBranchProjectRef<EGet, EFind, EParent = never, RParent = never>(
  input: string,
  projectRef: string | Effect.Effect<string, EParent, RParent>,
  mappers: LegacyBranchRefResolveMappers<EGet, EFind>,
) {
  return Effect.gen(function* () {
    if (LEGACY_BRANCH_PROJECT_REF_PATTERN.test(input)) {
      return input;
    }

    const api = yield* LegacyPlatformApi;

    if (LEGACY_BRANCH_UUID_PATTERN.test(input)) {
      const detail = yield* api.v1
        .getABranchConfig({ branch_id_or_ref: input })
        .pipe(Effect.catch(mappers.mapGetError));
      return detail.ref;
    }

    const parentRef = typeof projectRef === "string" ? projectRef : yield* projectRef;
    const branch = yield* api.v1
      .getABranch({ ref: parentRef, name: input })
      .pipe(Effect.catch(mappers.mapFindError));
    return branch.project_ref;
  });
}
