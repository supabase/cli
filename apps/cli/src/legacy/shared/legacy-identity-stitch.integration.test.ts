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
  isCi?: boolean;
  isFirstRun?: boolean;
  isTty?: boolean;
}) {
  return legacyIdentityStitchLayer.pipe(
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

describe("legacyIdentityStitchLayer — hybrid stamp/alias", () => {
  it.live("ephemeral (CI) runtime stamps the identity but does not alias or persist", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/legacy-identity-stitch-test-ci-" + String(Date.now());

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const svc = yield* LegacyIdentityStitch;

      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "gotrue-ci-1" }));

      // Stamped in memory so this process's captures carry the real user id
      // (restores CI/Docker/npx attribution)...
      expect(svc.stitchedDistinctId()).toBe("gotrue-ci-1");
      // ...but no alias is fired and nothing is persisted to the throwaway home.
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
    const configDir = "/tmp/legacy-identity-stitch-test-stale-" + String(Date.now());

    return Effect.gen(function* () {
      const svc = yield* LegacyIdentityStitch;

      // An identity already exists (telemetry.json held a previous user, surfaced
      // via runtime.identity) but the live token belongs to someone else.
      yield* svc.stitch(fakeResponse({ "x-gotrue-id": "new-user" }));

      // Memory is stamped with the live user so captures attribute correctly...
      expect(svc.stitchedDistinctId()).toBe("new-user");
      // ...but we never alias — that would merge two unrelated person graphs.
      expect(analytics.aliased).toHaveLength(0);
    }).pipe(
      Effect.provide(makeStitchLayer({ analytics, configDir, distinctId: "old-user" })),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    );
  });

  it.live("concurrent first responses alias exactly once", () => {
    const analytics = mockAnalytics();
    const configDir = "/tmp/legacy-identity-stitch-test-conc-" + String(Date.now());

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "telemetry.json"),
        JSON.stringify({ enabled: true, device_id: "device-001", schema_version: 1 }),
      );

      const svc = yield* LegacyIdentityStitch;

      // The stitchAttempted guard is set before the first yield, so two responses
      // racing through the shared stitcher alias at most once.
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
