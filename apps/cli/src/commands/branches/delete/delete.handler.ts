import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
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
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  // Force `Tty` into the handler's R channel so `promptBranchId` (which
  // requires it) resolves. The yielded value itself is unused.
  void (yield* Tty);

  // `branches` is parent-scoped: after `supabase link <branch>`, `supabase/.temp/project-ref`
  // holds the branch's own ref, and the platform 403s on that ref for every branches-management
  // endpoint.
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* promptBranchId(flags.name, ref);
    const branchRef = yield* resolveBranchProjectRef(branchInput, ref);

    const deleting =
      output.format === "text" ? yield* output.task("Deleting branch...") : undefined;
    yield* api.v1.deleteABranch({ branch_id_or_ref: branchRef }).pipe(
      Effect.tapError(() => deleting?.fail() ?? Effect.void),
      Effect.catch(mapDeleteError),
    );
    yield* deleting?.clear() ?? Effect.void;

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Deleted preview branch", { project_ref: branchRef });
      return;
    }
    yield* output.raw(`Deleted preview branch: ${branchRef}\n`, "stderr");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
