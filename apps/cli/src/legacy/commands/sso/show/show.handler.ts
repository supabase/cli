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
import {
  LegacySsoShowEnvNotSupportedError,
  LegacySsoShowNetworkError,
  LegacySsoShowNotFoundError,
  LegacySsoShowUnexpectedStatusError,
} from "../sso.errors.ts";
import { renderSingleProvider, validateUuid } from "../sso.format.ts";
import type { LegacySsoShowFlags } from "./show.command.ts";

const mapStatusOrNetwork = mapLegacyHttpError({
  networkError: LegacySsoShowNetworkError,
  statusError: LegacySsoShowUnexpectedStatusError,
  networkMessage: (cause) => `failed to get sso provider: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error fetching identity provider: ${body}`,
});

const handleShowError = (providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapStatusOrNetwork(cause));
    // Go's `get.go` does NOT call SuggestUpgradeOnError — `show` is intentionally
    // omitted from the upgrade-suggestion paths (see plan §"Telemetry parity").
    if (mapped._tag === "LegacySsoShowUnexpectedStatusError" && mapped.status === 404) {
      return yield* Effect.fail(
        new LegacySsoShowNotFoundError({
          message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
        }),
      );
    }
    return yield* Effect.fail(mapped);
  });

export const legacySsoShow = Effect.fn("legacy.sso.show")(function* (flags: LegacySsoShowFlags) {
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
      const fetching =
        output.format === "text" ? yield* output.task("Fetching SSO provider...") : undefined;
      const response = yield* api.v1.getASsoProvider({ ref, provider_id: providerId }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch((cause) => handleShowError(providerId, cause)),
      );
      yield* fetching?.clear() ?? Effect.void;

      // `--metadata` short-circuits regardless of `--output` — Go's `get.go:33-36`.
      if (flags.metadata) {
        yield* output.raw((response.saml?.metadata_xml ?? "") + "\n");
        return;
      }

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "env") {
        // Matches Go's `utils.ErrEnvNotSupported` verbatim
        // (`apps/cli-go/internal/utils/output.go:41`).
        return yield* Effect.fail(
          new LegacySsoShowEnvNotSupportedError({
            message: "--output env flag is not supported",
          }),
        );
      }
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

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", { ...response });
        return;
      }

      yield* output.raw(renderSingleProvider(response));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
