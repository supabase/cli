import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyBranchesDeleteNetworkError,
  LegacyBranchesDeleteUnexpectedStatusError,
} from "../branches.errors.ts";
import { legacyPromptBranchId } from "../branches.prompt.ts";
import { legacyResolveBranchProjectRef } from "../branches.resolver.ts";
import type { LegacyBranchesDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapLegacyHttpError({
  networkError: LegacyBranchesDeleteNetworkError,
  statusError: LegacyBranchesDeleteUnexpectedStatusError,
  networkMessage: (cause) => `failed to delete preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected delete branch status ${status}: ${body}`,
});

export const legacyBranchesDelete = Effect.fn("legacy.branches.delete")(function* (
  flags: LegacyBranchesDeleteFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  // Force `Tty` into the handler's R channel so `legacyPromptBranchId` (which
  // requires it) resolves. The yielded value itself is unused.
  void (yield* Tty);

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const branchInput = yield* legacyPromptBranchId(flags.name, ref);
    const branchRef = yield* legacyResolveBranchProjectRef(branchInput, ref);

    const deleting =
      output.format === "text" ? yield* output.task("Deleting branch...") : undefined;
    yield* api.v1.deleteABranch({ branch_id_or_ref: branchRef }).pipe(
      Effect.tapError(() => deleting?.fail() ?? Effect.void),
      Effect.catch(mapDeleteError),
    );
    yield* deleting?.clear() ?? Effect.void;

    // Go's `delete.go:28` writes `"Deleted preview branch: <ref>\n"` to STDERR.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Deleted preview branch", { project_ref: branchRef });
      return;
    }
    yield* output.raw(`Deleted preview branch: ${branchRef}\n`, "stderr");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
