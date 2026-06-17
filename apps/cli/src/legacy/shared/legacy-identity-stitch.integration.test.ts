import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mockAnalytics, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import { LegacyIdentityStitch, legacyIdentityStitchLayer } from "./legacy-identity-stitch.ts";

/**
 * Build a minimal fake HttpClientResponse carrying the given headers.
 */
function fakeResponse(headers: Record<string, string>): HttpClientResponse.HttpClientResponse {
  const request = HttpClientRequest.get("https://api.supabase.com/v1/projects");
  return HttpClientResponse.fromWeb(request, new Response(null, { status: 200, headers }));
}

function makeStitchLayer(opts: {
  analytics: ReturnType<typeof mockAnalytics>;
  configDir: string;
  deviceId?: string;
  distinctId?: string;
}) {
  return legacyIdentityStitchLayer.pipe(
    Layer.provide(opts.analytics.layer),
    Layer.provide(
      mockTelemetryRuntime({
        consent: "granted",
        isFirstRun: false,
        isCi: false,
        configDir: opts.configDir,
        deviceId: opts.deviceId ?? "device-001",
        distinctId: opts.distinctId,
      }),
    ),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunPath.layer),
  );
}

describe("legacyIdentityStitchLayer — stitchedDistinctId()", () => {
  it.live("populates stitchedDistinctId() after the first response with X-Gotrue-Id", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/legacy-identity-stitch-test-" + String(Date.now());

    return Effect.gen(function* () {
      // Write a valid telemetry.json so stitchIdentity sees enabled=true.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "telemetry.json"),
        JSON.stringify({ enabled: true, device_id: "device-001", schema_version: 1 }),
      );

      const svc = yield* LegacyIdentityStitch;

      // Before any stitch, stitchedDistinctId() is undefined.
      expect(svc.stitchedDistinctId()).toBeUndefined();

      // Stitch with a response carrying x-gotrue-id.
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-abc-123" }));

      // Now stitchedDistinctId() returns the gotrue id.
      expect(svc.stitchedDistinctId()).toBe("gotrue-abc-123");

      // The alias was fired once.
      expect(analytics.aliased).toHaveLength(1);
      expect(analytics.aliased[0]).toEqual({ distinctId: "gotrue-abc-123", alias: "device-001" });
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });

  it.live("once-only guard: a second stitch call with a different id keeps the first", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/legacy-identity-stitch-test-guard-" + String(Date.now());

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "telemetry.json"),
        JSON.stringify({ enabled: true, device_id: "device-001", schema_version: 1 }),
      );

      const svc = yield* LegacyIdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "first-id" }));
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "second-id" }));

      // stitchedDistinctId() must still reflect the first stitched id.
      expect(svc.stitchedDistinctId()).toBe("first-id");

      // alias fired exactly once.
      expect(analytics.aliased).toHaveLength(1);
      expect(analytics.aliased[0]?.distinctId).toBe("first-id");
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });
});
