import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockRuntimeInfo, mockTty } from "../../tests/helpers/mocks.ts";
import { CliSettings } from "../shared/config/cli-settings.service.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { analyticsLayer } from "./analytics.layer.ts";

const tempRoot = useTempWorkdir("supabase-analytics-destination-");

describe("analytics destination", () => {
  it.live("uses ambient telemetry configuration despite project destination settings", () => {
    const destinations: string[] = [];
    const recordingClient = HttpClient.make((request, url) =>
      Effect.sync(() => {
        destinations.push(url.toString());
        return HttpClientResponse.fromWeb(request, Response.json({ status: 1 }));
      }),
    );
    const settings = Layer.succeed(CliSettings, {
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://project-telemetry.invalid",
      telemetryPosthogKey: Option.some("project-key"),
      accessToken: Option.none(),
      noKeyring: Option.none(),
      supabaseHome: tempRoot.current,
      debug: Option.none(),
      telemetryDebug: Option.none(),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    });
    const layer = analyticsLayer.pipe(
      Layer.provide(settings),
      Layer.provide(mockRuntimeInfo({ homeDir: tempRoot.current })),
      Layer.provide(mockTty({ stdoutIsTty: false })),
      Layer.provide(BunServices.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, recordingClient)),
    );
    return Effect.gen(function* () {
      yield* Analytics.use((analytics) => analytics.capture("destination_test")).pipe(
        Effect.provide(layer),
      );
      expect(destinations.length).toBeGreaterThan(0);
      expect(
        destinations.every((url) => new URL(url).origin === "https://ambient-telemetry.invalid"),
      ).toBe(true);
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          SUPABASE_TELEMETRY_POSTHOG_HOST: "https://ambient-telemetry.invalid",
          SUPABASE_TELEMETRY_POSTHOG_KEY: "ambient-key",
        }),
      ),
    );
  });
});
