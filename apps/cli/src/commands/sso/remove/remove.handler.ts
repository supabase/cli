import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Result } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { GO_SSO_PROVIDER_RESPONSE } from "../sso.go-payload.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { gateResponse, suggestUpgrade } from "../../../command-internal/upgrade-suggest.ts";
import {
  SsoRemoveNetworkError,
  SsoRemoveNotFoundError,
  SsoRemoveUnexpectedStatusError,
  SsoTomlEncodeError,
} from "../sso.errors.ts";
import { renderSingleProvider, validateUuid } from "../sso.format.ts";
import type { SsoRemoveFlags } from "./remove.command.ts";

const mapStatusOrNetwork = mapHttpError({
  networkError: SsoRemoveNetworkError,
  statusError: SsoRemoveUnexpectedStatusError,
  networkMessage: (cause) => `failed to remove sso provider: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error removing identity provider: ${body}`,
});

const handleRemoveError = (ref: string, providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapStatusOrNetwork(cause));
    if (mapped._tag === "SsoRemoveUnexpectedStatusError") {
      const upgradeSuggested = yield* suggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
        response: gateResponse(cause),
      });
      if (mapped.status === 404) {
        return yield* Effect.fail(
          new SsoRemoveNotFoundError({
            message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
            upgradeSuggested,
          }),
        );
      }
      return yield* Effect.fail(
        new SsoRemoveUnexpectedStatusError({
          status: mapped.status,
          body: mapped.body,
          message: mapped.message,
          upgradeSuggested,
        }),
      );
    }
    return yield* Effect.fail(mapped);
  });

export const ssoRemove = Effect.fn("sso.remove")(function* (flags: SsoRemoveFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const providerId = yield* validateUuid(flags.providerId).pipe(
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }),
    );

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const removing =
        output.format === "text" ? yield* output.task("Removing SSO provider...") : undefined;
      const response = yield* api.v1.deleteASsoProvider({ ref, provider_id: providerId }).pipe(
        Effect.tapError(() => removing?.fail() ?? Effect.void),
        Effect.catch((cause) => handleRemoveError(ref, providerId, cause)),
      );
      yield* removing?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(response));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeGoYaml(response, GO_SSO_PROVIDER_RESPONSE));
        return;
      }
      if (goFmt === "toml") {
        // TOML encode failure wrapping — same pattern as list/show.
        const toml = yield* Effect.try({
          try: () => encodeGoToml(response, GO_SSO_PROVIDER_RESPONSE),
          catch: (cause) =>
            new SsoTomlEncodeError({
              message: `failed to output toml: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* output.raw(toml);
        return;
      }
      if (goFmt === "env") {
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", { ...response });
        return;
      }

      yield* output.raw(renderSingleProvider(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
