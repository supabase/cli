import { BunServices } from "@effect/platform-bun";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockRuntimeInfo, mockTty } from "../../tests/helpers/mocks.ts";
import { CliSettings } from "../shared/config/cli-settings.service.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { writeProjectLink } from "../command-internal/project-link.ts";
import { analyticsLayer, analyticsLayerFor } from "./analytics.layer.ts";

const tempRoot = useTempWorkdir("supabase-analytics-destination-");
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

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

  it.live("attributes events to the organization and project of a stack-mode link document", () => {
    const events: unknown[] = [];
    const recordingClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Raw" && request.body.body instanceof Uint8Array) {
          const bytes =
            request.headers["content-encoding"] === "gzip"
              ? gunzipSync(request.body.body)
              : request.body.body;
          const payload = yield* decodeJson(new TextDecoder().decode(bytes)).pipe(Effect.orDie);
          const batch =
            typeof payload === "object" ? Reflect.get(payload ?? {}, "batch") : undefined;
          if (Array.isArray(batch)) events.push(...batch);
        }
        return HttpClientResponse.fromWeb(request, Response.json({ status: 1 }));
      }),
    );
    const settings = Layer.succeed(CliSettings, {
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://project-telemetry.invalid",
      telemetryPosthogKey: Option.none(),
      accessToken: Option.none(),
      noKeyring: Option.none(),
      supabaseHome: tempRoot.current,
      debug: Option.none(),
      telemetryDebug: Option.none(),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    });
    const layer = analyticsLayerFor("stack").pipe(
      Layer.provide(settings),
      Layer.provide(mockRuntimeInfo({ homeDir: tempRoot.current, cwd: tempRoot.current })),
      Layer.provide(mockTty({ stdoutIsTty: false })),
      Layer.provide(BunServices.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, recordingClient)),
    );
    return Effect.gen(function* () {
      yield* writeProjectLink(tempRoot.current, {
        project: {
          ref: "abcdefghijklmnopqrst",
          organization_id: "org-1",
          organization_slug: "acme",
        },
        active_branch: { ref: "abcdefghijklmnopqrst" },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Analytics.use((analytics) => analytics.capture("stack_link_test")).pipe(
        Effect.provide(layer),
      );
      expect(events).toEqual([
        expect.objectContaining({
          event: "stack_link_test",
          properties: expect.objectContaining({
            $groups: { organization: "org-1", project: "abcdefghijklmnopqrst" },
          }),
        }),
      ]);
    }).pipe(
      Effect.provide(BunServices.layer),
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
