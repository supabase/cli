import type { V1ListAllSecretsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTomlListWrapper,
} from "../../../command-internal/struct-output.encoders.ts";
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
const SECRET_RESPONSE_SHAPE = shapeStruct([
  ["name", shapeString],
  ["updated_at", shapePtr(shapeString)],
  ["value", shapeString],
]);

const SECRETS_LIST_SHAPE = shapeSlice(SECRET_RESPONSE_SHAPE);

const SECRETS_TOML_WRAPPER_SHAPE = shapeTomlListWrapper("secrets", SECRET_RESPONSE_SHAPE);

export const secretsList = Effect.fn("secrets.list")(function* (flags: SecretsListFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
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
    yield* fetching?.clear ?? Effect.void;

    const sorted = sortSecrets(response);
    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    if (outputFlagFormat === "env") {
      return yield* new SecretsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (outputFlagFormat === "json") {
      yield* output.raw(encodeSortedJson(sorted));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw(encodeStructYaml(sorted, SECRETS_LIST_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      yield* output.raw(encodeStructToml({ secrets: sorted }, SECRETS_TOML_WRAPPER_SHAPE));
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { secrets: sorted });
      return;
    }

    yield* output.raw(renderSecretsListTable(sorted));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
