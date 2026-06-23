import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { mapLegacyHttpError, sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  decodeFunctionsResponse,
  encodeFunctionsGoJson,
  encodeFunctionsGoToml,
  encodeFunctionsGoYaml,
  hasJsonContentType,
} from "./list.encoders.ts";
import {
  LegacyFunctionsEnvNotSupportedError,
  LegacyFunctionsListNetworkError,
  LegacyFunctionsListUnexpectedStatusError,
} from "./list.errors.ts";
import { renderFunctionsTable } from "./list.format.ts";
import type { LegacyFunctionsListFlags } from "./list.command.ts";

const mapListError = mapLegacyHttpError({
  networkError: LegacyFunctionsListNetworkError,
  statusError: LegacyFunctionsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list functions: ${cause}`,
  statusMessage: (status, body) => `unexpected list functions status ${status}: ${body}`,
});

export const legacyFunctionsList = Effect.fn("legacy.functions.list")(function* (
  flags: LegacyFunctionsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  let resolvedProjectRef = Option.none<string>();

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef).pipe(
      Effect.tap((projectRef) =>
        Effect.sync(() => {
          resolvedProjectRef = Option.some(projectRef);
        }),
      ),
    );

    const fetching =
      output.format === "text" ? yield* output.task("Fetching functions...") : undefined;
    const response = yield* api.executeRaw(operationDefinitions.v1ListAllFunctions, { ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    if (response.status !== 200) {
      const body = sanitizeLegacyErrorBody(
        yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      );
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyFunctionsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected list functions status ${response.status}: ${body}`,
      });
    }
    const rawBody = yield* response.text.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(
        (cause) =>
          new LegacyFunctionsListNetworkError({ message: `failed to list functions: ${cause}` }),
      ),
    );
    if (!hasJsonContentType(response)) {
      const body = sanitizeLegacyErrorBody(rawBody);
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyFunctionsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected list functions status ${response.status}: ${body}`,
      });
    }
    const decodedFunctions = decodeFunctionsResponse(rawBody);
    if (!decodedFunctions.ok) {
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyFunctionsListNetworkError({
        message: decodedFunctions.message,
      });
    }
    yield* fetching?.clear() ?? Effect.void;
    const { functions, isNil } = decodedFunctions.value;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyFunctionsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeFunctionsGoJson({ functions, isNil }));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeFunctionsGoYaml(functions));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeFunctionsGoToml(functions));
      return;
    }
    if (goFmt === "pretty") {
      yield* output.raw(renderFunctionsTable(functions));
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { functions });
      return;
    }

    yield* output.raw(renderFunctionsTable(functions));
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Option.match(resolvedProjectRef, {
          onNone: () => Effect.void,
          onSome: (ref) => linkedProjectCache.cache(ref),
        }),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
