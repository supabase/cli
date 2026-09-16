import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { mapDomainsHttpError } from "../domains.errors.ts";
import type { DomainsDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapDomainsHttpError("delete");

const DELETE_SUCCESS_MESSAGE = "Deleted custom hostname config successfully.";

// `flags.includeRawOutput` is unread: `--include-raw-output` is a persistent flag on the
// `domains` group, so it's accepted on `delete` too, but ignored — delete has no response
// body to encode. Asserted by the "ignores --include-raw-output" integration test.
export const domainsDelete = Effect.fn("domains.delete")(function* (flags: DomainsDeleteFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const deleting =
      output.format === "text"
        ? yield* output.task("Deleting custom hostname config...")
        : undefined;
    // Delete returns an empty (void) body, so `-o` has nothing to encode; only the success
    // line prints to stderr.
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
