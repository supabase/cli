import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import {
  BranchesUnpauseNetworkError,
  BranchesUnpauseUnexpectedStatusError,
} from "../branches.errors.ts";
import { promptBranchId } from "../branches.prompt.ts";
import { resolveBranchProjectRef } from "../branches.resolver.ts";
import type { BranchesUnpauseFlags } from "./unpause.command.ts";

const mapUnpauseError = mapHttpError({
  networkError: BranchesUnpauseNetworkError,
  statusError: BranchesUnpauseUnexpectedStatusError,
  networkMessage: (cause) => `failed to unpause branch: ${cause}`,
  statusMessage: (status, body) => `unexpected unpause branch status ${status}: ${body}`,
});

export const branchesUnpause = Effect.fn("branches.unpause")(function* (
  flags: BranchesUnpauseFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  // Force `Tty` into the handler's R channel so `promptBranchId` (which
  // requires it) resolves. The yielded value itself is unused.
  void (yield* Tty);

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* promptBranchId(flags.name, ref);
    const branchRef = yield* resolveBranchProjectRef(branchInput, ref);

    const restoring =
      output.format === "text" ? yield* output.task("Unpausing branch...") : undefined;
    yield* api.v1.restoreAProject({ ref: branchRef }).pipe(
      Effect.tapError(() => restoring?.fail() ?? Effect.void),
      Effect.catch(mapUnpauseError),
    );
    yield* restoring?.clear() ?? Effect.void;
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
