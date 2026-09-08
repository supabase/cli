import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { mapHttpError, sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  decodeFunctionsResponse,
  encodeFunctionsGoJson,
  encodeFunctionsGoToml,
  encodeFunctionsGoYaml,
  hasJsonContentType,
} from "./list.encoders.ts";
import {
  FunctionsEnvNotSupportedError,
  FunctionsListNetworkError,
  FunctionsListUnexpectedStatusError,
} from "./list.errors.ts";
import { renderFunctionsTable } from "./list.format.ts";
import type { FunctionsListFlags } from "./list.command.ts";

const mapListError = mapHttpError({
  networkError: FunctionsListNetworkError,
  statusError: FunctionsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list functions: ${cause}`,
  statusMessage: (status, body) => `unexpected list functions status ${status}: ${body}`,
});

export const functionsList = Effect.fn("functions.list")(function* (flags: FunctionsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
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
      const body = sanitizeErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
      yield* fetching?.fail() ?? Effect.void;
      return yield* new FunctionsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected list functions status ${response.status}: ${body}`,
      });
    }
    const rawBody = yield* response.text.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(
        (cause) => new FunctionsListNetworkError({ message: `failed to list functions: ${cause}` }),
      ),
    );
    if (!hasJsonContentType(response)) {
      const body = sanitizeErrorBody(rawBody);
      yield* fetching?.fail() ?? Effect.void;
      return yield* new FunctionsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected list functions status ${response.status}: ${body}`,
      });
    }
    const decodedFunctions = decodeFunctionsResponse(rawBody);
    if (!decodedFunctions.ok) {
      yield* fetching?.fail() ?? Effect.void;
      return yield* new FunctionsListNetworkError({
        message: decodedFunctions.message,
        decode: true,
      });
    }
    yield* fetching?.clear() ?? Effect.void;
    const { functions, isNil } = decodedFunctions.value;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new FunctionsEnvNotSupportedError({
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
      yield* output.raw(encodeFunctionsGoToml({ functions, isNil }));
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
