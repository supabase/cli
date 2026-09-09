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
import {
  SsoShowEnvNotSupportedError,
  SsoShowNetworkError,
  SsoShowNotFoundError,
  SsoShowUnexpectedStatusError,
  SsoTomlEncodeError,
} from "../sso.errors.ts";
import { renderSingleProvider, validateUuid } from "../sso.format.ts";
import type { SsoShowFlags } from "./show.command.ts";

const mapStatusOrNetwork = mapHttpError({
  networkError: SsoShowNetworkError,
  statusError: SsoShowUnexpectedStatusError,
  networkMessage: (cause) => `failed to get sso provider: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error fetching identity provider: ${body}`,
});

const handleShowError = (providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapStatusOrNetwork(cause));
    // `show` is intentionally omitted from the upgrade-suggestion paths
    // (see plan §"Telemetry parity").
    if (mapped._tag === "SsoShowUnexpectedStatusError" && mapped.status === 404) {
      return yield* Effect.fail(
        new SsoShowNotFoundError({
          message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
        }),
      );
    }
    return yield* Effect.fail(mapped);
  });

export const ssoShow = Effect.fn("sso.show")(function* (flags: SsoShowFlags) {
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
      const fetching =
        output.format === "text" ? yield* output.task("Fetching SSO provider...") : undefined;
      const response = yield* api.v1.getASsoProvider({ ref, provider_id: providerId }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch((cause) => handleShowError(providerId, cause)),
      );
      yield* fetching?.clear() ?? Effect.void;

      // `--metadata` short-circuits regardless of `--output`.
      if (flags.metadata) {
        yield* output.raw((response.saml?.metadata_xml ?? "") + "\n");
        return;
      }

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "env") {
        // Established `--output env` unsupported error message.
        return yield* Effect.fail(
          new SsoShowEnvNotSupportedError({
            message: "--output env flag is not supported",
          }),
        );
      }
      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(response));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeGoYaml(response, GO_SSO_PROVIDER_RESPONSE));
        return;
      }
      if (goFmt === "toml") {
        // TOML encode failure wrapping (e.g. a nil element in an
        // attribute-mapping `default` array).
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

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", { ...response });
        return;
      }

      yield* output.raw(renderSingleProvider(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
