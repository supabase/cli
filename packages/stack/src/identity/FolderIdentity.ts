import { Effect } from "effect";
import { InvalidStackIdentityError } from "../public/Errors.ts";

export interface FolderIdentityParts {
  readonly workspaceId: string;
  readonly checkoutId: string;
  readonly branchContext: "ordinary-workspace";
  readonly localProjectKey: ".";
  readonly checkoutRoot: string;
}

/** Builds the read-only identity tuple for a project outside of Git. */
export const resolveFolderIdentity = (
  canonicalProjectRoot: string,
): Effect.Effect<FolderIdentityParts, InvalidStackIdentityError> =>
  canonicalProjectRoot.length === 0
    ? Effect.fail(
        new InvalidStackIdentityError({
          projectRoot: canonicalProjectRoot,
          reason: "The canonical project root is empty",
        }),
      )
    : Effect.succeed({
        workspaceId: canonicalProjectRoot,
        checkoutId: canonicalProjectRoot,
        branchContext: "ordinary-workspace",
        localProjectKey: ".",
        checkoutRoot: canonicalProjectRoot,
      });
