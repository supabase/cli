import type { SupabaseApiError } from "@supabase/api/effect";
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
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyGateResponse,
  legacySuggestUpgrade,
} from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoListNetworkError,
  LegacySsoListSamlDisabledError,
  LegacySsoListUnexpectedStatusError,
  LegacySsoTomlEncodeError,
} from "../sso.errors.ts";
import { renderListProviders } from "../sso.format.ts";
import type { LegacySsoListFlags } from "./list.command.ts";

const SAML_DISABLED_MESSAGE =
  "Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.";

const mapStatusOrNetwork = mapLegacyHttpError({
  networkError: LegacySsoListNetworkError,
  statusError: LegacySsoListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list sso providers: ${cause}`,
  statusMessage: (_status, body) => `unexpected error listing identity providers: ${body}`,
});

const handleListError = (ref: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapStatusOrNetwork(cause));
    if (mapped._tag === "LegacySsoListUnexpectedStatusError") {
      yield* legacySuggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
        response: legacyGateResponse(cause),
      });
      if (mapped.status === 404) {
        return yield* Effect.fail(
          new LegacySsoListSamlDisabledError({ message: SAML_DISABLED_MESSAGE }),
        );
      }
    }
    return yield* Effect.fail(mapped);
  });

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
      const response = yield* api.v1.listAllSsoProvider({ ref }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch((cause) => handleListError(ref, cause)),
      );
      yield* fetching?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);
      const payload = { providers: response.items };

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(payload));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeLegacyGoYaml(payload, LEGACY_GO_SSO_PROVIDERS_WRAPPER));
        return;
      }
      if (goFmt === "toml") {
        // Mirror Go's `utils.EncodeOutput` failure wrapping when BurntSushi
        // rejects the payload (e.g. a nil element in an attribute-mapping
        // `default` array).
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

      yield* output.raw(renderListProviders(response.items));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
