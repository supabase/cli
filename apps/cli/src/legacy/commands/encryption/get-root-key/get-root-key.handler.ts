import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { mapLegacyEncryptionHttpError } from "../encryption.errors.ts";
import type { LegacyEncryptionGetRootKeyFlags } from "./get-root-key.command.ts";

const mapGetError = mapLegacyEncryptionHttpError({ networkVerb: "retrieve", statusVerb: "get" });

export const legacyEncryptionGetRootKey = Effect.fn("legacy.encryption.get-root-key")(function* (
  flags: LegacyEncryptionGetRootKeyFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Mirror Go's PersistentPostRun: write the linked-project cache and persist
  // the telemetry state file on success and failure.
  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching root key...") : undefined;
    const { root_key } = yield* api.v1.getPgsodiumConfig({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapGetError),
    );
    yield* fetching?.clear() ?? Effect.void;

    if (output.format !== "text") {
      // json / stream-json — emit a structured result.
      yield* output.success("", { root_key });
      return;
    }

    // text — Go prints the bare key + newline to stdout (`fmt.Println`).
    yield* output.raw(root_key + "\n", "stdout");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
