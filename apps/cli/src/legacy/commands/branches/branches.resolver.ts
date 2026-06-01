import { Effect } from "effect";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";
import {
  LegacyBranchesFindNetworkError,
  LegacyBranchesFindUnexpectedStatusError,
  LegacyBranchesGetNetworkError,
  LegacyBranchesGetUnexpectedStatusError,
} from "./branches.errors.ts";

/**
 * Project ref pattern shared by every Management-API endpoint that accepts a
 * 20-lowercase-letter project reference. Re-export so siblings (e.g.
 * `get.handler.ts`) can classify branch-id inputs without re-declaring it.
 */
export const LEGACY_BRANCH_PROJECT_REF_PATTERN = /^[a-z]{20}$/;

/**
 * Permissive UUID pattern (any 8-4-4-4-12 hex sequence). Go uses
 * `github.com/google/uuid`'s `uuid.Validate` which accepts any RFC 4122
 * variant including v6/v7 and version 0 — we mirror that liberal acceptance
 * rather than the v1–v5 + variant-1 subset.
 */
export const LEGACY_BRANCH_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mapFindError = mapLegacyHttpError({
  networkError: LegacyBranchesFindNetworkError,
  statusError: LegacyBranchesFindUnexpectedStatusError,
  networkMessage: (cause) => `failed to find branch: ${cause}`,
  statusMessage: (status, body) => `unexpected find branch status ${status}: ${body}`,
});

const mapGetError = mapLegacyHttpError({
  networkError: LegacyBranchesGetNetworkError,
  statusError: LegacyBranchesGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to get branch: ${cause}`,
  statusMessage: (status, body) => `unexpected get branch status ${status}: ${body}`,
});

/**
 * Reproduces `apps/cli-go/internal/branches/pause/pause.go:GetBranchProjectRef`:
 *
 * 1. If the input matches `^[a-z]{20}$`, it's already a project ref — return as-is.
 * 2. Else if the input is a UUID, call `V1GetABranchConfig` (`GET /v1/branches/{id}`)
 *    and return `JSON200.ref`.
 * 3. Otherwise treat as a branch name under the linked project ref: call
 *    `V1GetABranch` (`GET /v1/projects/{ref}/branches/{name}`) and return
 *    `JSON200.project_ref`.
 *
 * The persistent `--project-ref` is required for path 3 and is passed in by
 * the caller (which has already run `LegacyProjectRefResolver` so the linked
 * project cache write does not re-fire here).
 */
export const legacyResolveBranchProjectRef = Effect.fnUntraced(function* (
  input: string,
  projectRef: string,
) {
  if (LEGACY_BRANCH_PROJECT_REF_PATTERN.test(input)) {
    return input;
  }

  const api = yield* LegacyPlatformApi;

  if (LEGACY_BRANCH_UUID_PATTERN.test(input)) {
    const detail = yield* api.v1
      .getABranchConfig({ branch_id_or_ref: input })
      .pipe(Effect.catch(mapGetError));
    return detail.ref;
  }

  const branch = yield* api.v1
    .getABranch({ ref: projectRef, name: input })
    .pipe(Effect.catch(mapFindError));
  return branch.project_ref;
});
