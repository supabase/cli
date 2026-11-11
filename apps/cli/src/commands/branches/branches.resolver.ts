import { mapHttpError } from "../../command-internal/http-errors.ts";
import { resolveBranchProjectRef as resolveBranchProjectRefShared } from "../../command-internal/branch-ref.resolver.ts";
import {
  BranchesFindNetworkError,
  BranchesFindUnexpectedStatusError,
  BranchesGetNetworkError,
  BranchesGetUnexpectedStatusError,
} from "./branches.errors.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";

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
 * Binds the shared branch-ref resolver to this family's error classes. See
 * `command-internal/branch-ref.resolver.ts` for resolution semantics.
 */
export function resolveBranchProjectRef(input: string, projectRef: string) {
  return resolveBranchProjectRefShared(input, projectRef, { mapGetError, mapFindError });
}

/** Names the branch a command acts on as its target, under which the parent project follows. */
export const announceBranchTarget = (input: string, branchRef: string | undefined) =>
  CommandTarget.use((target) =>
    target.announceSubject({
      name: input === branchRef ? undefined : input,
      id: branchRef,
      preview: true,
    }),
  );
