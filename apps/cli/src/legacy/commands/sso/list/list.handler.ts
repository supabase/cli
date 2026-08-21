import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
} from "../../../shared/legacy-go-struct-output.encoders.ts";
import { LEGACY_GO_SSO_PROVIDERS_WRAPPER } from "../sso.go-payload.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoListNetworkError,
  LegacySsoListSamlDisabledError,
  LegacySsoListUnexpectedStatusError,
  LegacySsoTomlEncodeError,
} from "../sso.errors.ts";
import {
  normalizeLegacySsoProviderPayload,
  readLegacySsoProviderItems,
  renderListProviders,
  toLegacySsoProviderView,
} from "../sso.format.ts";
import type { LegacySsoListFlags } from "./list.command.ts";

const SAML_DISABLED_MESSAGE =
  "Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.";

export const legacySsoList = Effect.fn("legacy.sso.list")(function* (flags: LegacySsoListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Fetching SSO providers...") : undefined;
      const response = yield* api
        .executeRaw(operationDefinitions.v1ListAllSsoProvider, { ref })
        .pipe(
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
          Effect.mapError(
            (cause) =>
              new LegacySsoListNetworkError({
                message: `failed to list sso providers: ${String(cause)}`,
              }),
          ),
        );

      if (response.status !== 200) {
        const body = sanitizeLegacyErrorBody(
          yield* response.text.pipe(Effect.orElseSucceed(() => "")),
        );
        yield* fetching?.fail() ?? Effect.void;
        const upgradeSuggested = yield* legacySuggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
          response,
        });
        if (response.status === 404) {
          return yield* Effect.fail(
            new LegacySsoListSamlDisabledError({
              message: SAML_DISABLED_MESSAGE,
              upgradeSuggested,
            }),
          );
        }
        return yield* Effect.fail(
          new LegacySsoListUnexpectedStatusError({
            status: response.status,
            body,
            message: `unexpected error listing identity providers: ${body}`,
            upgradeSuggested,
          }),
        );
      }

      const parsed = yield* response.json.pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new LegacySsoListNetworkError({
              message: `failed to list sso providers: ${String(cause)}`,
              decode: true,
            }),
        ),
      );
      const rawItems = readLegacySsoProviderItems(parsed);
      if (rawItems === undefined) {
        yield* fetching?.fail() ?? Effect.void;
        return yield* Effect.fail(
          new LegacySsoListNetworkError({
            message: "failed to list sso providers: response did not contain an items array",
            decode: true,
          }),
        );
      }
      yield* fetching?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);
      const items = rawItems.map(normalizeLegacySsoProviderPayload);
      const payload = { providers: items };

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(payload));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeLegacyGoYaml(payload, LEGACY_GO_SSO_PROVIDERS_WRAPPER));
        return;
      }
      if (goFmt === "toml") {
        // TOML encode failure wrapping (e.g. a nil element in an
        // attribute-mapping `default` array).
        const toml = yield* Effect.try({
          try: () => encodeLegacyGoToml(payload, LEGACY_GO_SSO_PROVIDERS_WRAPPER),
          catch: (cause) =>
            new LegacySsoTomlEncodeError({
              message: `failed to output toml: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* output.raw(toml);
        return;
      }
      if (goFmt === "env") {
        yield* output.raw(encodeEnv(payload) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", payload);
        return;
      }

      yield* output.raw(renderListProviders(rawItems.map(toLegacySsoProviderView)));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
