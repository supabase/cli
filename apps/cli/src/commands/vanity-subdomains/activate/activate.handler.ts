import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { gateResponse, suggestUpgrade } from "../../../command-internal/upgrade-suggest.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goString,
  goStruct,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  DesiredSubdomainRequiredError,
  VanitySubdomainsActivateNetworkError,
  VanitySubdomainsActivateUnexpectedStatusError,
} from "../vanity-subdomains.errors.ts";
import type { VanitySubdomainsActivateFlags } from "./activate.command.ts";

/** Type shape for `api.ActivateVanitySubdomainResponse` (`types.gen.go`). */
const GO_ACTIVATE_VANITY_RESPONSE = goStruct([["custom_domain", goString]]);

const mapActivateError = mapHttpError({
  networkError: VanitySubdomainsActivateNetworkError,
  statusError: VanitySubdomainsActivateUnexpectedStatusError,
  networkMessage: (cause) => `failed activate vanity subdomain: ${cause}`,
  statusMessage: (status, body) => `unexpected activate vanity subdomain status ${status}: ${body}`,
});

export const vanitySubdomainsActivate = Effect.fn("vanity-subdomains.activate")(function* (
  flags: VanitySubdomainsActivateFlags,
) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      // Go validates the required `--desired-subdomain` only after
      // `PersistentPreRunE` completes (gate → login → ref resolution,
      // `cmd/root.go:93-117`; `cobra@v1.10.2/command.go:985,1005`), and
      // `PersistentPostRun` still fires telemetry + the linked-project cache
      // on that failure — hence this check sits inside both `Effect.ensuring`
      // wrappers, after ref resolution. Cobra checks the flag was *changed*,
      // not non-empty, so `--desired-subdomain ""` passes and reaches the API.
      if (Option.isNone(flags.desiredSubdomain)) {
        return yield* Effect.fail(
          new DesiredSubdomainRequiredError({
            message: `required flag(s) "desired-subdomain" not set`,
          }),
        );
      }
      const desiredSubdomain = flags.desiredSubdomain.value;
      const activating =
        output.format === "text" ? yield* output.task("Activating vanity subdomain...") : undefined;
      const response = yield* api.v1
        .activateVanitySubdomainConfig({
          ref,
          vanity_subdomain: desiredSubdomain,
        })
        .pipe(
          Effect.tapError(() => activating?.fail() ?? Effect.void),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              // Flip the always-failing mapper into a success so we can inspect the
              // tagged error before deciding whether to suggest an upgrade, then re-fail.
              const mapped = yield* Effect.flip(mapActivateError(cause));
              if (mapped._tag === "VanitySubdomainsActivateUnexpectedStatusError") {
                const upgradeSuggested = yield* suggestUpgrade({
                  projectRef: ref,
                  featureKey: "vanity_subdomain",
                  statusCode: mapped.status,
                  response: gateResponse(cause),
                });
                return yield* Effect.fail(
                  new VanitySubdomainsActivateUnexpectedStatusError({
                    status: mapped.status,
                    body: mapped.body,
                    message: mapped.message,
                    upgradeSuggested,
                  }),
                );
              }
              return yield* Effect.fail(mapped);
            }),
          ),
        );
      yield* activating?.clear() ?? Effect.void;

      const goOutput = Option.getOrUndefined(outputFlag);

      if (goOutput === "json") {
        yield* output.raw(encodeGoJson(response));
        return;
      }
      if (goOutput === "yaml") {
        yield* output.raw(encodeGoYaml(response, GO_ACTIVATE_VANITY_RESPONSE));
        return;
      }
      if (goOutput === "toml") {
        yield* output.raw(encodeGoToml(response, GO_ACTIVATE_VANITY_RESPONSE));
        return;
      }
      if (goOutput === "env") {
        yield* output.raw(encodeEnv(response) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(`Activated vanity subdomain at ${response.custom_domain}\n`);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
