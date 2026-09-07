import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";
import { legacyResolveBranchProjectRef as legacyResolveBranchProjectRefShared } from "../../shared/legacy-branch-ref.resolver.ts";
import {
  LegacyBranchesFindNetworkError,
  LegacyBranchesFindUnexpectedStatusError,
  LegacyBranchesGetNetworkError,
  LegacyBranchesGetUnexpectedStatusError,
} from "./branches.errors.ts";

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
 * The branches family's binding of the shared branch-ref resolver
 * (`legacy/shared/legacy-branch-ref.resolver.ts`) to this family's error
 * classes. See the shared module for resolution semantics.
 */
export function legacyResolveBranchProjectRef(input: string, projectRef: string) {
  return legacyResolveBranchProjectRefShared(input, projectRef, { mapGetError, mapFindError });
}
