import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { mapLegacyDomainsHttpError } from "../domains.errors.ts";
import type { LegacyDomainsDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapLegacyDomainsHttpError("delete");

const DELETE_SUCCESS_MESSAGE = "Deleted custom hostname config successfully.";

// `flags.includeRawOutput` is intentionally unread: Go declares `--include-raw-output`
// as a persistent flag on the `domains` group, so it is accepted on `delete` too, but
// Go's `delete.Run` ignores it (delete has no response body to encode). We mirror that —
// the flag is inert here, asserted by the "ignores --include-raw-output" integration test.
export const legacyDomainsDelete = Effect.fn("legacy.domains.delete")(function* (
  flags: LegacyDomainsDeleteFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const deleting =
      output.format === "text"
        ? yield* output.task("Deleting custom hostname config...")
        : undefined;
    // Delete returns an empty (void) body; Go ignores `-o` here and only prints
    // the success line to stderr.
    yield* api.v1.deleteHostnameConfig({ ref }).pipe(
      Effect.tapError(() => deleting?.fail() ?? Effect.void),
      Effect.catch(mapDeleteError),
    );
    yield* deleting?.clear() ?? Effect.void;

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success(DELETE_SUCCESS_MESSAGE, {});
      return;
    }
    yield* output.raw(`${DELETE_SUCCESS_MESSAGE}\n`, "stderr");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
