import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacySecretsEnvNotSupportedError,
  LegacySecretsListNetworkError,
  LegacySecretsListUnexpectedStatusError,
} from "../secrets.errors.ts";
import { renderSecretsListTable } from "../secrets.format.ts";
import type { LegacySecretsListFlags } from "./list.command.ts";

type Secrets = typeof V1ListAllSecretsOutput.Type;

const mapListError = mapLegacyHttpError({
  networkError: LegacySecretsListNetworkError,
  statusError: LegacySecretsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list secrets: ${cause}`,
  statusMessage: (status, body) => `unexpected list secrets status ${status}: ${body}`,
});

function sortSecrets(secrets: Secrets): Secrets {
  return [...secrets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const legacySecretsList = Effect.fn("legacy.secrets.list")(function* (
  flags: LegacySecretsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Mirror Go's PersistentPostRun: write the linked-project cache and persist
  // the telemetry state file whether the main API call succeeds or fails.
  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching secrets...") : undefined;
    const response = yield* api.v1.listAllSecrets({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const sorted = sortSecrets(response);
    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacySecretsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(sorted));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(sorted));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml({ secrets: sorted }) + "\n");
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for JSON/stream-json,
    // otherwise render the Glamour-styled table (Go --output pretty parity).
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { secrets: sorted });
      return;
    }

    yield* output.raw(renderSecretsListTable(sorted));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
