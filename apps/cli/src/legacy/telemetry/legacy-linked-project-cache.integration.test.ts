import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyCredentialsLayer,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../tests/helpers/legacy-mocks.ts";
import { legacyIdentityStitchLayer } from "../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "./legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "./legacy-linked-project-cache.service.ts";

describe("legacyLinkedProjectCacheLayer", () => {
  const temp = useLegacyTempWorkdir("legacy-linked-cache-");
  const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
  const LinkedProjectCacheSchema = Schema.Struct({
    ref: Schema.String,
    name: Schema.String,
    organization_id: Schema.String,
    organization_slug: Schema.String,
  });
  const encodeLinkedProject = Schema.encodeUnknownSync(
    Schema.fromJsonString(LinkedProjectCacheSchema),
  );
  const decodeLinkedProject = Schema.decodeUnknownSync(
    Schema.fromJsonString(LinkedProjectCacheSchema),
  );

  it.live(
    "stitches session identity from the cache GET's X-Gotrue-Id (Go identityTransport)",
    () => {
      // Go runs ensureProjectGroupsCached's GET through GetSupabase()'s
      // identityTransport, so the X-Gotrue-Id stitches the session identity — the
      // only stitch opportunity for a password-only `--linked` run. Mirror that here.
      const workdir = temp.current;
      const analytics = mockAnalytics();
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                encodeLinkedProject({
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
            configDir: path.join(workdir, ".supabase"),
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
        expect(analytics.aliased.some(({ distinctId }) => distinctId === "gotrue-abc")).toBe(true);
        // The linked-project cache is still written.
        const fs = yield* FileSystem.FileSystem;
        const written = yield* fs.readFileString(
          path.join(workdir, "supabase", ".temp", "linked-project.json"),
        );
        expect(decodeLinkedProject(written).ref).toBe(LEGACY_VALID_REF);
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
      }).pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer)));
    },
  );

  it.live("does not re-identify groups when the linked-project cache already exists", () => {
    // Cache hit → Go's HasLinkedProject guard returns early, so no write and no
    // GroupIdentify. The TS `exists` early-return must match.
    const workdir = temp.current;
    const analytics = mockAnalytics();
    const api = mockLegacyPlatformApi({
      handler: () => Effect.die("cache GET must not run on a cache hit"),
    });
    const identityStitch = legacyIdentityStitchLayer.pipe(
      Layer.provide(analytics.layer),
      Layer.provide(
        mockTelemetryRuntime({ configDir: path.join(workdir, ".supabase"), consent: "granted" }),
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
      const fs = yield* FileSystem.FileSystem;
      const cachePath = path.join(workdir, "supabase", ".temp", "linked-project.json");
      yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
      yield* fs.writeFileString(
        cachePath,
        encodeLinkedProject({
          ref: LEGACY_VALID_REF,
          name: "proj",
          organization_id: "org-1",
          organization_slug: "acme",
        }),
      );
      const cache = yield* LegacyLinkedProjectCache;
      yield* cache.cache(LEGACY_VALID_REF, workdir);
      expect(analytics.groupIdentified).toEqual([]);
      expect(analytics.aliased).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer)));
  });

  it.live(
    "skips the fill when project-ref names a DIFFERENT ref: the cache must describe the linked workdir, not the resolved ref (PR #6168 review)",
    () => {
      // A mid-flight `link --project-ref B` failure still reaches the fill via
      // Effect.ensuring while `project-ref` holds the OLD link — caching B
      // would make the parent chain prefer a never-linked project. The guard
      // runs before any token/network work, so the GET must never fire.
      const OTHER_REF = "otherprojectrefabcde";
      const workdir = temp.current;
      const analytics = mockAnalytics();
      const api = mockLegacyPlatformApi({
        handler: () => Effect.die("cache GET must not run when project-ref diverges"),
      });
      const identityStitch = legacyIdentityStitchLayer.pipe(
        Layer.provide(analytics.layer),
        Layer.provide(
          mockTelemetryRuntime({ configDir: path.join(workdir, ".supabase"), consent: "granted" }),
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
        const fs = yield* FileSystem.FileSystem;
        const refPath = path.join(workdir, "supabase", ".temp", "project-ref");
        yield* fs.makeDirectory(path.dirname(refPath), { recursive: true });
        yield* fs.writeFileString(refPath, LEGACY_VALID_REF);
        const cache = yield* LegacyLinkedProjectCache;
        yield* cache.cache(OTHER_REF, workdir);
        expect(
          yield* fs.exists(path.join(workdir, "supabase", ".temp", "linked-project.json")),
        ).toBe(false);
        expect(analytics.groupIdentified).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer)));
    },
  );
});
