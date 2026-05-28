import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { suggestUpgradeOnError } from "../../../telemetry/legacy-upgrade-suggested.ts";
import {
  LegacySsoListNetworkError,
  LegacySsoListSamlDisabledError,
  LegacySsoListUnexpectedStatusError,
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
      yield* suggestUpgradeOnError(ref, "auth.saml_2", mapped.status);
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
        yield* output.raw(encodeYaml(payload));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(payload) + "\n");
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
