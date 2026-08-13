import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { legacyResolveParentScopedProjectRef } from "../../../shared/legacy-parent-project-ref.ts";
import {
  LegacyBranchesUnpauseNetworkError,
  LegacyBranchesUnpauseUnexpectedStatusError,
} from "../branches.errors.ts";
import { legacyPromptBranchId } from "../branches.prompt.ts";
import { legacyResolveBranchProjectRef } from "../branches.resolver.ts";
import type { LegacyBranchesUnpauseFlags } from "./unpause.command.ts";

const mapUnpauseError = mapLegacyHttpError({
  networkError: LegacyBranchesUnpauseNetworkError,
  statusError: LegacyBranchesUnpauseUnexpectedStatusError,
  networkMessage: (cause) => `failed to unpause branch: ${cause}`,
  statusMessage: (status, body) => `unexpected unpause branch status ${status}: ${body}`,
});

export const legacyBranchesUnpause = Effect.fn("legacy.branches.unpause")(function* (
  flags: LegacyBranchesUnpauseFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  // Force `Tty` into the handler's R channel so `legacyPromptBranchId` (which
  // requires it) resolves. The yielded value itself is unused.
  void (yield* Tty);

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* legacyResolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* legacyPromptBranchId(flags.name, ref);
    const branchRef = yield* legacyResolveBranchProjectRef(branchInput, ref);

    const restoring =
      output.format === "text" ? yield* output.task("Unpausing branch...") : undefined;
    yield* api.v1.restoreAProject({ ref: branchRef }).pipe(
      Effect.tapError(() => restoring?.fail() ?? Effect.void),
      Effect.catch(mapUnpauseError),
    );
    yield* restoring?.clear() ?? Effect.void;
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
