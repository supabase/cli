import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { mapEncryptionHttpError } from "../encryption.errors.ts";
import type { EncryptionGetRootKeyFlags } from "./get-root-key.command.ts";

const mapGetError = mapEncryptionHttpError({ networkVerb: "retrieve", statusVerb: "get" });

export const encryptionGetRootKey = Effect.fn("encryption.get-root-key")(function* (
  flags: EncryptionGetRootKeyFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Write the linked-project cache and persist the telemetry state file on
  // success and failure.
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
