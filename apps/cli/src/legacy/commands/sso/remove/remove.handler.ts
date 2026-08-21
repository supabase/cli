import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option, Result } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
} from "../../../shared/legacy-go-struct-output.encoders.ts";
import { LEGACY_GO_SSO_PROVIDER_RESPONSE } from "../sso.go-payload.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoRemoveNetworkError,
  LegacySsoRemoveNotFoundError,
  LegacySsoRemoveUnexpectedStatusError,
  LegacySsoTomlEncodeError,
} from "../sso.errors.ts";
import {
  normalizeLegacySsoProviderPayload,
  renderSingleProvider,
  toLegacySsoProviderView,
  validateUuid,
} from "../sso.format.ts";
import type { LegacySsoRemoveFlags } from "./remove.command.ts";

export const legacySsoRemove = Effect.fn("legacy.sso.remove")(function* (
  flags: LegacySsoRemoveFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const providerId = yield* validateUuid(flags.providerId).pipe(
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }),
    );

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const removing =
        output.format === "text" ? yield* output.task("Removing SSO provider...") : undefined;
      const response = yield* api
        .executeRaw(operationDefinitions.v1DeleteASsoProvider, { ref, provider_id: providerId })
        .pipe(
          Effect.tapError(() => removing?.fail() ?? Effect.void),
          Effect.mapError(
            (cause) =>
              new LegacySsoRemoveNetworkError({
                message: `failed to remove sso provider: ${String(cause)}`,
              }),
          ),
        );

      if (response.status !== 200) {
        const body = sanitizeLegacyErrorBody(
          yield* response.text.pipe(Effect.orElseSucceed(() => "")),
        );
        yield* removing?.fail() ?? Effect.void;
        const upgradeSuggested = yield* legacySuggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
          response,
        });
        if (response.status === 404) {
          return yield* Effect.fail(
            new LegacySsoRemoveNotFoundError({
              message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
              upgradeSuggested,
            }),
          );
        }
        return yield* Effect.fail(
          new LegacySsoRemoveUnexpectedStatusError({
            status: response.status,
            body,
            message: `Unexpected error removing identity provider: ${body}`,
            upgradeSuggested,
          }),
        );
      }

      const parsed = yield* response.json.pipe(
        Effect.tapError(() => removing?.fail() ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new LegacySsoRemoveNetworkError({
              message: `failed to remove sso provider: ${String(cause)}`,
            }),
        ),
      );
      const normalizedResponse = normalizeLegacySsoProviderPayload(parsed);
      yield* removing?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(normalizedResponse));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeLegacyGoYaml(normalizedResponse, LEGACY_GO_SSO_PROVIDER_RESPONSE));
        return;
      }
      if (goFmt === "toml") {
        // TOML encode failure wrapping — same pattern as list/show.
        const toml = yield* Effect.try({
          try: () => encodeLegacyGoToml(normalizedResponse, LEGACY_GO_SSO_PROVIDER_RESPONSE),
          catch: (cause) =>
            new LegacySsoTomlEncodeError({
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
        yield* output.success("", normalizedResponse);
        return;
      }

      yield* output.raw(renderSingleProvider(toLegacySsoProviderView(normalizedResponse)));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
