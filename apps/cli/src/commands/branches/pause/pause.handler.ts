import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import {
  BranchesPauseNetworkError,
  BranchesPauseUnexpectedStatusError,
} from "../branches.errors.ts";
import { promptBranchId } from "../branches.prompt.ts";
import { resolveBranchProjectRef } from "../branches.resolver.ts";
import type { BranchesPauseFlags } from "./pause.command.ts";

const mapPauseError = mapHttpError({
  networkError: BranchesPauseNetworkError,
  statusError: BranchesPauseUnexpectedStatusError,
  networkMessage: (cause) => `failed to pause branch: ${cause}`,
  statusMessage: (status, body) => `unexpected pause branch status ${status}: ${body}`,
});

export const branchesPause = Effect.fn("branches.pause")(function* (flags: BranchesPauseFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  void (yield* Tty); // ensures Tty is in handler R so promptBranchId resolves

  // `branches` is parent-scoped: after `supabase link <branch>`, `supabase/.temp/project-ref`
  // holds the branch's own ref, which the platform 403s on for every branches-management endpoint.
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* promptBranchId(flags.name, ref);
    const branchRef = yield* resolveBranchProjectRef(branchInput, ref);

    const pausing = output.format === "text" ? yield* output.task("Pausing branch...") : undefined;
    yield* api.v1.pauseAProject({ ref: branchRef }).pipe(
      Effect.tapError(() => pausing?.fail() ?? Effect.void),
      Effect.catch(mapPauseError),
    );
    yield* pausing?.clear() ?? Effect.void;
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
