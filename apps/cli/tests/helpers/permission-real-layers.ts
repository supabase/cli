import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import type * as HttpClient from "effect/http/HttpClient";

import { identityStitchLayer } from "../../src/command-internal/identity-stitch.ts";
import type { CommandSettings } from "../../src/config/command-settings.service.ts";
import { linkedProjectCacheLayer } from "../../src/telemetry/linked-project-cache.layer.ts";
import type { LinkedProjectCache } from "../../src/telemetry/linked-project-cache.service.ts";
import { mockCommandCredentialsLayer } from "./command-mocks.ts";
import { mockAnalytics, mockTelemetryRuntime } from "./mocks.ts";

/**
 * The real `LinkedProjectCache`, so a command test records the `GET /v1/projects/{ref}` the
 * cache fill makes and the command's declaration is checked against it.
 */
export function realLinkedProjectCache(opts: {
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
  readonly cliSettings: Layer.Layer<CommandSettings>;
}): Layer.Layer<LinkedProjectCache> {
  const analytics = mockAnalytics();
  const identityStitch = identityStitchLayer.pipe(
    Layer.provide(analytics.layer),
    Layer.provide(mockTelemetryRuntime()),
    Layer.provide(BunServices.layer),
  );
  return linkedProjectCacheLayer.pipe(
    Layer.provide(opts.httpClient),
    Layer.provide(opts.cliSettings),
    Layer.provide(mockCommandCredentialsLayer),
    Layer.provide(identityStitch),
    Layer.provide(analytics.layer),
    Layer.provide(BunServices.layer),
  );
}
