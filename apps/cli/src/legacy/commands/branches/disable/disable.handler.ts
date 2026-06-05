import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyBranchesDisableNetworkError,
  LegacyBranchesDisableUnexpectedStatusError,
} from "../branches.errors.ts";
import type { LegacyBranchesDisableFlags } from "./disable.command.ts";

const mapDisableError = mapLegacyHttpError({
  networkError: LegacyBranchesDisableNetworkError,
  statusError: LegacyBranchesDisableUnexpectedStatusError,
  networkMessage: (cause) => `failed to disable preview branching: ${cause}`,
  statusMessage: (status, body) => `unexpected disable branching status ${status}: ${body}`,
});

export const legacyBranchesDisable = Effect.fn("legacy.branches.disable")(function* (
  flags: LegacyBranchesDisableFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const disabling =
      output.format === "text" ? yield* output.task("Disabling preview branching...") : undefined;
    yield* api.v1.disablePreviewBranching({ ref }).pipe(
      Effect.tapError(() => disabling?.fail() ?? Effect.void),
      Effect.catch(mapDisableError),
    );
    yield* disabling?.clear() ?? Effect.void;

    // Go's `disable.go:22` writes to STDOUT via `fmt.Println`.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Disabled preview branching for project", { project_ref: ref });
      return;
    }
    yield* output.raw(`Disabled preview branching for project: ${ref}\n`);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
