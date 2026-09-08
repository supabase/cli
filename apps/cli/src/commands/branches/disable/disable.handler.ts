import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import {
  BranchesDisableNetworkError,
  BranchesDisableUnexpectedStatusError,
} from "../branches.errors.ts";
import type { BranchesDisableFlags } from "./disable.command.ts";

const mapDisableError = mapHttpError({
  networkError: BranchesDisableNetworkError,
  statusError: BranchesDisableUnexpectedStatusError,
  networkMessage: (cause) => `failed to disable preview branching: ${cause}`,
  statusMessage: (status, body) => `unexpected disable branching status ${status}: ${body}`,
});

export const branchesDisable = Effect.fn("branches.disable")(function* (
  flags: BranchesDisableFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    const disabling =
      output.format === "text" ? yield* output.task("Disabling preview branching...") : undefined;
    yield* api.v1.disablePreviewBranching({ ref }).pipe(
      Effect.tapError(() => disabling?.fail() ?? Effect.void),
      Effect.catch(mapDisableError),
    );
    yield* disabling?.clear() ?? Effect.void;

    // Established behavior: this message writes to STDOUT.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Disabled preview branching for project", { project_ref: ref });
      return;
    }
    yield* output.raw(`Disabled preview branching for project: ${ref}\n`);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
