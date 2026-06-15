import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyCredentialsLayer,
  mockLegacyPlatformApi,
} from "../../../tests/helpers/legacy-mocks.ts";
import { legacyIdentityStitchLayer } from "../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "./legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "./legacy-linked-project-cache.service.ts";

describe("legacyLinkedProjectCacheLayer", () => {
  it.live(
    "stitches session identity from the cache GET's X-Gotrue-Id (Go identityTransport)",
    () => {
      // Go runs ensureProjectGroupsCached's GET through GetSupabase()'s
      // identityTransport, so the X-Gotrue-Id stitches the session identity — the
      // only stitch opportunity for a password-only `--linked` run. Mirror that here.
      const workdir = mkdtempSync(join(tmpdir(), "legacy-linked-cache-"));
      const analytics = mockAnalytics();
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  ref: LEGACY_VALID_REF,
                  name: "proj",
                  organization_id: "org-1",
                  organization_slug: "acme",
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json", "x-gotrue-id": "gotrue-abc" },
                },
              ),
            ),
          ),
      });
      // The cache GET stitches identity via the single `LegacyIdentityStitch`
      // service; build it from this test's Analytics / TelemetryRuntime fakes so
      // the alias assertion below exercises the real stitch path.
      const identityStitch = legacyIdentityStitchLayer.pipe(
        Layer.provide(analytics.layer),
        Layer.provide(
          mockTelemetryRuntime({
            configDir: join(workdir, ".supabase"),
            consent: "granted",
            distinctId: undefined,
            isCi: false,
            isFirstRun: false,
            isTty: true,
          }),
        ),
        Layer.provide(BunServices.layer),
      );
      const layer = legacyLinkedProjectCacheLayer.pipe(
        Layer.provide(api.httpClientLayer),
        Layer.provide(mockLegacyCliConfig({ workdir })),
        Layer.provide(mockLegacyCredentialsLayer),
        Layer.provide(identityStitch),
        // The cache now also fires org/project groupIdentify (Go parity); it reads
        // Analytics directly, so provide the same mock the stitcher uses.
        Layer.provide(analytics.layer),
        Layer.provide(BunServices.layer),
      );
      return Effect.gen(function* () {
        const cache = yield* LegacyLinkedProjectCache;
        yield* cache.cache(LEGACY_VALID_REF, workdir);
        // Identity stitched from the cache response's X-Gotrue-Id.
        expect(JSON.stringify(analytics.aliased)).toContain("gotrue-abc");
        // The linked-project cache is still written.
        const written: unknown = JSON.parse(
          readFileSync(join(workdir, "supabase", ".temp", "linked-project.json"), "utf8"),
        );
        expect((written as { ref: string }).ref).toBe(LEGACY_VALID_REF);
        // Go's CacheProjectAndIdentifyGroups also publishes org + project groups on
        // the same cache miss (telemetry/project.go:66-88).
        expect(analytics.groupIdentified).toEqual([
          {
            groupType: "organization",
            groupKey: "org-1",
            properties: { organization_slug: "acme" },
          },
          {
            groupType: "project",
            groupKey: LEGACY_VALID_REF,
            properties: { name: "proj", organization_slug: "acme" },
          },
        ]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not re-identify groups when the linked-project cache already exists", () => {
    // Cache hit → Go's HasLinkedProject guard returns early, so no write and no
    // GroupIdentify. The TS `exists` early-return must match.
    const workdir = mkdtempSync(join(tmpdir(), "legacy-linked-cache-hit-"));
    mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", ".temp", "linked-project.json"),
      JSON.stringify({
        ref: LEGACY_VALID_REF,
        name: "proj",
        organization_id: "org-1",
        organization_slug: "acme",
      }),
    );
    const analytics = mockAnalytics();
    const api = mockLegacyPlatformApi({
      handler: () => Effect.die("cache GET must not run on a cache hit"),
    });
    const identityStitch = legacyIdentityStitchLayer.pipe(
      Layer.provide(analytics.layer),
      Layer.provide(
        mockTelemetryRuntime({ configDir: join(workdir, ".supabase"), consent: "granted" }),
      ),
      Layer.provide(BunServices.layer),
    );
    const layer = legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(api.httpClientLayer),
      Layer.provide(mockLegacyCliConfig({ workdir })),
      Layer.provide(mockLegacyCredentialsLayer),
      Layer.provide(identityStitch),
      Layer.provide(analytics.layer),
      Layer.provide(BunServices.layer),
    );
    return Effect.gen(function* () {
      const cache = yield* LegacyLinkedProjectCache;
      yield* cache.cache(LEGACY_VALID_REF, workdir);
      expect(analytics.groupIdentified).toEqual([]);
      expect(analytics.aliased).toEqual([]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(layer));
  });
});
