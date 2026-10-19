import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { mapDomainsHttpError } from "../domains.errors.ts";
import type { DomainsDeleteFlags } from "./delete.command.ts";

const mapDeleteError = mapDomainsHttpError("delete");

const DELETE_SUCCESS_MESSAGE = "Deleted custom hostname config successfully.";

export const domainsDelete = Effect.fn("domains.delete")(function* (flags: DomainsDeleteFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolveProjectTarget({ remote: flags.remote, projectRef: flags.projectRef });

  yield* Effect.gen(function* () {
    yield* requireHostedMutationConsent({ action: "Delete the custom hostname config" });

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
    yield* deleting?.clear ?? Effect.void;

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success(DELETE_SUCCESS_MESSAGE, {});
      return;
    }
    yield* output.raw(`${DELETE_SUCCESS_MESSAGE}\n`, "stderr");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
