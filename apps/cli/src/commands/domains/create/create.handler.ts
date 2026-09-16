import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { verifyCname } from "../domains.cname.ts";
import { emitHostnameResult } from "../domains.emit.ts";
import { mapDomainsHttpError } from "../domains.errors.ts";
import { gateMapError } from "../../../command-internal/upgrade-suggest.ts";
import type { DomainsCreateFlags } from "./create.command.ts";

const mapCreateError = mapDomainsHttpError("create");

export const domainsCreate = Effect.fn("domains.create")(function* (flags: DomainsCreateFlags) {
  const output = yield* Output;
  const httpClient = yield* HttpClient.HttpClient;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Write the linked-project cache and persist the telemetry state file on
  // success and failure.
  yield* Effect.gen(function* () {
    // 1. Verify the CNAME first — short-circuits before any POST.
    yield* verifyCname({
      httpClient,
      projectHost: cliSettings.projectHost,
      ref,
      customHostname: flags.customHostname,
    });

    // 2. Initialize the custom hostname.
    const creating =
      output.format === "text" ? yield* output.task("Creating custom hostname...") : undefined;
    const response = yield* api.v1
      .updateHostnameConfig({ ref, custom_hostname: flags.customHostname })
      .pipe(
        Effect.tapError(() => creating?.fail() ?? Effect.void),
        Effect.catch(gateMapError({ projectRef: ref }, mapCreateError)),
      );
    yield* creating?.clear() ?? Effect.void;

    yield* emitHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
