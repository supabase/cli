import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandUX, ResolvedProject } from "../../../command-internal/command-executor.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import {
  BranchesDeleteNetworkError,
  BranchesDeleteUnexpectedStatusError,
} from "../branches.errors.ts";
import { promptBranchId } from "../branches.prompt.ts";
import { resolveBranchProjectRef } from "../branches.resolver.ts";
import type { BranchesDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapHttpError({
  networkError: BranchesDeleteNetworkError,
  statusError: BranchesDeleteUnexpectedStatusError,
  networkMessage: (cause) => `failed to delete preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected delete branch status ${status}: ${body}`,
});

export const branchesDelete = Effect.fn("branches.delete")(function* (flags: BranchesDeleteFlags) {
  const ux = yield* CommandUX;
  const api = yield* CommandPlatformApi;
  const resolvedProject = yield* ResolvedProject;

  // `branches` is parent-scoped: after `supabase link <branch>`, `supabase/.temp/project-ref`
  // holds the branch's own ref, and the platform 403s on that ref for every branches-management
  // endpoint.
  const ref = yield* resolveProjectTarget(
    { remote: flags.remote, projectRef: flags.projectRef },
    { parent: true },
  );
  yield* resolvedProject.record(ref);
  yield* Effect.annotateCurrentSpan("project.ref", ref);

  const branchInput = yield* promptBranchId(flags.name, ref);
  const branchRef = yield* resolveBranchProjectRef(branchInput, ref);

  yield* requireHostedMutationConsent({
    action: `Delete preview branch ${branchInput}`,
    details: [`Branch project ref: ${branchRef}`],
  });

  yield* ux
    .task("Deleting branch...", api.v1.deleteABranch({ branch_id_or_ref: branchRef }))
    .pipe(Effect.catch(mapDeleteError));
  yield* ux.message(`Deleted preview branch: ${branchRef}`);
  return { project_ref: branchRef, message: "Deleted preview branch" } as const;
});
