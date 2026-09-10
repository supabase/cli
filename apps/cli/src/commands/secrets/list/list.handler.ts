import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goPtr,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  SecretsEnvNotSupportedError,
  SecretsListNetworkError,
  SecretsListUnexpectedStatusError,
} from "../secrets.errors.ts";
import { renderSecretsListTable } from "../secrets.format.ts";
import type { SecretsListFlags } from "./list.command.ts";

type Secrets = typeof V1ListAllSecretsOutput.Type;

const mapListError = mapHttpError({
  networkError: SecretsListNetworkError,
  statusError: SecretsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list secrets: ${cause}`,
  statusMessage: (status, body) => `unexpected list secrets status ${status}: ${body}`,
});

function sortSecrets(secrets: Secrets): Secrets {
  return [...secrets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Struct shape for the secrets response; drives `-o yaml|toml` key casing. */
const GO_SECRET_RESPONSE = goStruct([
  ["name", goString],
  ["updated_at", goPtr(goString)],
  ["value", goString],
]);

const GO_SECRETS_LIST = goSlice(GO_SECRET_RESPONSE);

const GO_SECRETS_TOML_WRAPPER = goTomlListWrapper("secrets", GO_SECRET_RESPONSE);

export const secretsList = Effect.fn("secrets.list")(function* (flags: SecretsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

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
      return yield* new SecretsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(sorted));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeGoYaml(sorted, GO_SECRETS_LIST));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeGoToml({ secrets: sorted }, GO_SECRETS_TOML_WRAPPER));
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { secrets: sorted });
      return;
    }

    yield* output.raw(renderSecretsListTable(sorted));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
