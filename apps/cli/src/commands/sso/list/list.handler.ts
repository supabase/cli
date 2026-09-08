import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { GO_SSO_PROVIDERS_WRAPPER } from "../sso.go-payload.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { gateResponse, suggestUpgrade } from "../../../command-internal/upgrade-suggest.ts";
import {
  SsoListNetworkError,
  SsoListSamlDisabledError,
  SsoListUnexpectedStatusError,
  SsoTomlEncodeError,
} from "../sso.errors.ts";
import { renderListProviders } from "../sso.format.ts";
import type { SsoListFlags } from "./list.command.ts";

const SAML_DISABLED_MESSAGE =
  "Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.";

const mapStatusOrNetwork = mapHttpError({
  networkError: SsoListNetworkError,
  statusError: SsoListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list sso providers: ${cause}`,
  statusMessage: (_status, body) => `unexpected error listing identity providers: ${body}`,
});

const handleListError = (ref: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapStatusOrNetwork(cause));
    if (mapped._tag === "SsoListUnexpectedStatusError") {
      const upgradeSuggested = yield* suggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
        response: gateResponse(cause),
      });
      if (mapped.status === 404) {
        return yield* Effect.fail(
          new SsoListSamlDisabledError({ message: SAML_DISABLED_MESSAGE, upgradeSuggested }),
        );
      }
      return yield* Effect.fail(
        new SsoListUnexpectedStatusError({
          status: mapped.status,
          body: mapped.body,
          message: mapped.message,
          upgradeSuggested,
        }),
      );
    }
    return yield* Effect.fail(mapped);
  });

export const ssoList = Effect.fn("sso.list")(function* (flags: SsoListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

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
        yield* output.raw(encodeGoYaml(payload, GO_SSO_PROVIDERS_WRAPPER));
        return;
      }
      if (goFmt === "toml") {
        // TOML encode failure wrapping (e.g. a nil element in an
        // attribute-mapping `default` array).
        const toml = yield* Effect.try({
          try: () => encodeGoToml(payload, GO_SSO_PROVIDERS_WRAPPER),
          catch: (cause) =>
            new SsoTomlEncodeError({
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
