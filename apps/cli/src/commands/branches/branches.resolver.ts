import { mapHttpError } from "../../command-internal/http-errors.ts";
import { resolveBranchProjectRef as resolveBranchProjectRefShared } from "../../command-internal/branch-ref.resolver.ts";
import {
  BranchesFindNetworkError,
  BranchesFindUnexpectedStatusError,
  BranchesGetNetworkError,
  BranchesGetUnexpectedStatusError,
} from "./branches.errors.ts";

const mapFindError = mapHttpError({
  networkError: BranchesFindNetworkError,
  statusError: BranchesFindUnexpectedStatusError,
  networkMessage: (cause) => `failed to find branch: ${cause}`,
  statusMessage: (status, body) => `unexpected find branch status ${status}: ${body}`,
});

const mapGetError = mapHttpError({
  networkError: BranchesGetNetworkError,
  statusError: BranchesGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to get branch: ${cause}`,
  statusMessage: (status, body) => `unexpected get branch status ${status}: ${body}`,
});

/**
 * The branches family's binding of the shared branch-ref resolver
 * (`command-internal/branch-ref.resolver.ts`) to this family's error
 * classes. See the shared module for resolution semantics.
 */
export function resolveBranchProjectRef(input: string, projectRef: string) {
  return resolveBranchProjectRefShared(input, projectRef, { mapGetError, mapFindError });
}
