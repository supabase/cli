import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { BunServices } from "@effect/platform-bun";
import { mockAnalytics, mockTelemetryRuntime } from "../../tests/helpers/mocks.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";
import { IdentityStitch, identityStitchLayer } from "./identity-stitch.ts";

function fakeResponse(headers: Record<string, string>): HttpClientResponse.HttpClientResponse {
  const request = HttpClientRequest.get("https://api.supabase.com/v1/projects");
  return HttpClientResponse.fromWeb(request, new Response(null, { status: 200, headers }));
}

function makeStitchLayer(opts: {
  analytics: ReturnType<typeof mockAnalytics>;
  deviceId?: string;
  distinctId?: string;
  isCi?: boolean;
  isFirstRun?: boolean;
  isTty?: boolean;
}) {
  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return mockTelemetryRuntime({
        consent: "granted",
        isFirstRun: opts.isFirstRun ?? false,
        isTty: opts.isTty ?? false,
        isCi: opts.isCi ?? false,
        configDir: yield* fs.makeTempDirectoryScoped({ prefix: "identity-stitch-test-" }),
        deviceId: opts.deviceId ?? "device-001",
        distinctId: opts.distinctId,
      });
    }),
  );
  return identityStitchLayer.pipe(
    Layer.provideMerge(runtime),
    Layer.provide(opts.analytics.layer),
    Layer.provideMerge(BunServices.layer),
  );
}

const writeEnabledTelemetry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { configDir } = yield* TelemetryRuntime;
  yield* fs.writeFileString(
    path.join(configDir, "telemetry.json"),
    `{"enabled":true,"device_id":"device-001","schema_version":1}`,
  );
});

describe("identityStitchLayer — stitchedDistinctId()", () => {
  it.live("populates stitchedDistinctId() after the first response with X-Gotrue-Id", () => {
    const analytics = mockAnalytics();

    return Effect.gen(function* () {
      // Write a valid telemetry.json so stitchIdentity sees enabled=true.
      yield* writeEnabledTelemetry;

      const svc = yield* IdentityStitch;

      expect(svc.stitchedDistinctId()).toBeUndefined();

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-abc-123" }));

      expect(svc.stitchedDistinctId()).toBe("gotrue-abc-123");

      expect(analytics.aliased).toHaveLength(1);
      expect(analytics.aliased[0]).toEqual({ distinctId: "gotrue-abc-123", alias: "device-001" });
    }).pipe(Effect.provide(makeStitchLayer({ analytics })));
  });

  it.live("once-only guard: a second stitch call with a different id keeps the first", () => {
    const analytics = mockAnalytics();

    return Effect.gen(function* () {
      yield* writeEnabledTelemetry;

      const svc = yield* IdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "first-id" }));
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "second-id" }));

      expect(svc.stitchedDistinctId()).toBe("first-id");

      expect(analytics.aliased).toHaveLength(1);
      expect(analytics.aliased[0]?.distinctId).toBe("first-id");
    }).pipe(Effect.provide(makeStitchLayer({ analytics })));
  });
});

describe("identityStitchLayer — hybrid stamp/alias", () => {
  it.live("ephemeral (CI) runtime stamps the identity but does not alias or persist", () => {
    const analytics = mockAnalytics();

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* TelemetryRuntime;
      const svc = yield* IdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-ci-1" }));

      expect(svc.stitchedDistinctId()).toBe("gotrue-ci-1");
      expect(analytics.aliased).toHaveLength(0);
      const exists = yield* fs.exists(path.join(configDir, "telemetry.json"));
      expect(exists).toBe(false);
    }).pipe(Effect.provide(makeStitchLayer({ analytics, isCi: true })));
  });

  it.live("stamps over a stale persisted identity without aliasing", () => {
    const analytics = mockAnalytics();

    return Effect.gen(function* () {
      const svc = yield* IdentityStitch;

      // distinctId seeds an existing identity, so this exercises the no-realias branch.
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "new-user" }));

      expect(svc.stitchedDistinctId()).toBe("new-user");
      expect(analytics.aliased).toHaveLength(0);
    }).pipe(Effect.provide(makeStitchLayer({ analytics, distinctId: "old-user" })));
  });

  it.live("persists a prior int64 schema_version token byte for byte", () => {
    const analytics = mockAnalytics();

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* TelemetryRuntime;
      const telemetryPath = path.join(configDir, "telemetry.json");
      yield* fs.writeFileString(
        telemetryPath,
        `{"enabled":true,"device_id":"device-001","session_id":"session-001","session_last_active":"2026-01-01T00:00:00.000Z","schema_version":9007199254740993}`,
      );
      const svc = yield* IdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-int64" }));

      const written = yield* fs.readFileString(telemetryPath);
      expect(written).toContain(`"schema_version":9007199254740993}`);
      expect(written).toMatch(
        /"session_last_active":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/,
      );
      expect(written).toContain(`"distinct_id":"gotrue-int64"`);
    }).pipe(Effect.provide(makeStitchLayer({ analytics })));
  });

  it.live("concurrent first responses alias exactly once", () => {
    const analytics = mockAnalytics();

    return Effect.gen(function* () {
      yield* writeEnabledTelemetry;

      const svc = yield* IdentityStitch;

      yield* Effect.all(
        [
          svc.stitch(fakeResponse({ "x-gotrue-id": "id-a" })),
          svc.stitch(fakeResponse({ "x-gotrue-id": "id-b" })),
        ],
        { concurrency: "unbounded" },
      );

      expect(analytics.aliased).toHaveLength(1);
      expect(svc.stitchedDistinctId()).toBe(analytics.aliased[0]?.distinctId);
    }).pipe(Effect.provide(makeStitchLayer({ analytics })));
  });
});
