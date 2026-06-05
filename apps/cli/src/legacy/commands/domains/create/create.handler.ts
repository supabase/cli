import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { verifyLegacyCname } from "../domains.cname.ts";
import { emitLegacyHostnameResult } from "../domains.emit.ts";
import { mapLegacyDomainsHttpError } from "../domains.errors.ts";
import type { LegacyDomainsCreateFlags } from "./create.command.ts";

const mapCreateError = mapLegacyDomainsHttpError("create");

export const legacyDomainsCreate = Effect.fn("legacy.domains.create")(function* (
  flags: LegacyDomainsCreateFlags,
) {
  const output = yield* Output;
  const httpClient = yield* HttpClient.HttpClient;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Mirror Go's PersistentPostRun (`apps/cli-go/cmd/root.go:176`): write the
  // linked-project cache and persist the telemetry state file on success and failure.
  yield* Effect.gen(function* () {
    // 1. Verify the CNAME first (Go step 1) — short-circuits before any POST.
    yield* verifyLegacyCname({
      httpClient,
      projectHost: cliConfig.projectHost,
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
        Effect.catch(mapCreateError),
      );
    yield* creating?.clear() ?? Effect.void;

    yield* emitLegacyHostnameResult(response, flags.includeRawOutput);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
