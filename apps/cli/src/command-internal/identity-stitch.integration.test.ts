import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mockAnalytics, mockTelemetryRuntime } from "../../tests/helpers/mocks.ts";
import { IdentityStitch, identityStitchLayer } from "./identity-stitch.ts";

function fakeResponse(headers: Record<string, string>): HttpClientResponse.HttpClientResponse {
  const request = HttpClientRequest.get("https://api.supabase.com/v1/projects");
  return HttpClientResponse.fromWeb(request, new Response(null, { status: 200, headers }));
}

function makeStitchLayer(opts: {
  analytics: ReturnType<typeof mockAnalytics>;
  configDir: string;
  deviceId?: string;
  distinctId?: string;
  isCi?: boolean;
  isFirstRun?: boolean;
  isTty?: boolean;
}) {
  return identityStitchLayer.pipe(
    Layer.provide(opts.analytics.layer),
    Layer.provide(
      mockTelemetryRuntime({
        consent: "granted",
        isFirstRun: opts.isFirstRun ?? false,
        isTty: opts.isTty ?? false,
        isCi: opts.isCi ?? false,
        configDir: opts.configDir,
        deviceId: opts.deviceId ?? "device-001",
        distinctId: opts.distinctId,
      }),
    ),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunPath.layer),
  );
}

describe("identityStitchLayer — stitchedDistinctId()", () => {
  it.live("populates stitchedDistinctId() after the first response with X-Gotrue-Id", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/identity-stitch-test-" + String(Date.now());

    return Effect.gen(function* () {
      // Write a valid telemetry.json so stitchIdentity sees enabled=true.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "telemetry.json"),
        JSON.stringify({ enabled: true, device_id: "device-001", schema_version: 1 }),
      );

      const svc = yield* IdentityStitch;

      expect(svc.stitchedDistinctId()).toBeUndefined();

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-abc-123" }));

      expect(svc.stitchedDistinctId()).toBe("gotrue-abc-123");

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
    const configDir = "/tmp/identity-stitch-test-guard-" + String(Date.now());

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "telemetry.json"),
        JSON.stringify({ enabled: true, device_id: "device-001", schema_version: 1 }),
      );

      const svc = yield* IdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "first-id" }));
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "second-id" }));

      expect(svc.stitchedDistinctId()).toBe("first-id");

      expect(analytics.aliased).toHaveLength(1);
      expect(analytics.aliased[0]?.distinctId).toBe("first-id");
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });
});

describe("identityStitchLayer — hybrid stamp/alias", () => {
  it.live("ephemeral (CI) runtime stamps the identity but does not alias or persist", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/identity-stitch-test-ci-" + String(Date.now());

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const svc = yield* IdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-ci-1" }));

      expect(svc.stitchedDistinctId()).toBe("gotrue-ci-1");
      expect(analytics.aliased).toHaveLength(0);
      const exists = yield* fs.exists(path.join(configDir, "telemetry.json"));
      expect(exists).toBe(false);
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir, isCi: true })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });

  it.live("stamps over a stale persisted identity without aliasing", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/identity-stitch-test-stale-" + String(Date.now());

    return Effect.gen(function* () {
      const svc = yield* IdentityStitch;

      // distinctId seeds an existing identity, so this exercises the no-realias branch.
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "new-user" }));

      expect(svc.stitchedDistinctId()).toBe("new-user");
      expect(analytics.aliased).toHaveLength(0);
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir, distinctId: "old-user" })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });

  it.live("concurrent first responses alias exactly once", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/identity-stitch-test-conc-" + String(Date.now());

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "telemetry.json"),
        JSON.stringify({ enabled: true, device_id: "device-001", schema_version: 1 }),
      );

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
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });
});
