import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Result } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoRemoveNetworkError,
  LegacySsoRemoveNotFoundError,
  LegacySsoRemoveUnexpectedStatusError,
} from "../sso.errors.ts";
import { renderSingleProvider, validateUuid } from "../sso.format.ts";
import type { LegacySsoRemoveFlags } from "./remove.command.ts";

const mapStatusOrNetwork = mapLegacyHttpError({
  networkError: LegacySsoRemoveNetworkError,
  statusError: LegacySsoRemoveUnexpectedStatusError,
  networkMessage: (cause) => `failed to remove sso provider: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error removing identity provider: ${body}`,
});

const handleRemoveError = (ref: string, providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapStatusOrNetwork(cause));
    if (mapped._tag === "LegacySsoRemoveUnexpectedStatusError") {
      yield* legacySuggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
      });
      if (mapped.status === 404) {
        return yield* Effect.fail(
          new LegacySsoRemoveNotFoundError({
            message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
          }),
        );
      }
    }
    return yield* Effect.fail(mapped);
  });

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
        yield* output.raw(encodeYaml(response));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(response) + "\n");
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
