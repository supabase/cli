import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { mockAnalytics, mockTelemetryRuntime } from "../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  mockCommandSettings,
  mockCommandCredentialsLayer,
  mockCommandPlatformApi,
} from "../../tests/helpers/command-mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { linkedProjectCache, linkedProjectCacheLayer } from "./linked-project-cache.layer.ts";
import { identityStitchLayer } from "../command-internal/identity-stitch.ts";
import { LinkedProjectCache } from "./linked-project-cache.service.ts";
import { projectStateModeLayer } from "../shared/config/project-state-mode.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("linkedProjectCacheLayer", () => {
  it.live("stitches session identity from the cache GET's X-Gotrue-Id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "linked-cache-" });
      const analytics = mockAnalytics();
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  ref: VALID_REF,
                  id: VALID_REF,
                  name: "proj",
                  organization_id: "org-1",
                  organization_slug: "acme",
                  region: "us-east-1",
                  created_at: "2026-01-01T00:00:00Z",
                  status: "ACTIVE_HEALTHY",
                  database: {
                    host: "db.example.com",
                    version: "15",
                    postgres_engine: "15",
                    release_channel: "ga",
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json", "x-gotrue-id": "gotrue-abc" },
                },
              ),
            ),
          ),
      });
      // The cache GET stitches identity via the single `IdentityStitch`
      // service; build it from this test's Analytics / TelemetryRuntime fakes so
      // the alias assertion below exercises the real stitch path.
      const identityStitch = identityStitchLayer.pipe(
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
      const layer = linkedProjectCacheLayer.pipe(
        Layer.provide(api.httpClientLayer),
        Layer.provide(mockCommandSettings({ workdir })),
        Layer.provide(mockCommandCredentialsLayer),
        Layer.provide(identityStitch),
        // The cache also fires org/project groupIdentify; it reads Analytics directly, so
        // provide the same mock the stitcher uses.
        Layer.provide(analytics.layer),
        Layer.provide(BunServices.layer),
      );
      yield* Effect.gen(function* () {
        const cache = yield* LinkedProjectCache;
        yield* cache.cache(VALID_REF, workdir);
        expect(api.requests).toHaveLength(1);
        assertBlockDrift(linkedProjectCache, {
          activeFlags: {},
          requests: api.requests,
        });
        expect(yield* encodeJson(analytics.aliased)).toContain("gotrue-abc");
        expect(
          yield* fs.readFileString(path.join(workdir, "supabase", ".temp", "linked-project.json")),
        ).toBe(
          `{"ref":"${VALID_REF}","name":"proj","organization_id":"org-1","organization_slug":"acme"}`,
        );
        expect(analytics.groupIdentified).toEqual([
          {
            groupType: "organization",
            groupKey: "org-1",
            properties: { organization_slug: "acme" },
          },
          {
            groupType: "project",
            groupKey: VALID_REF,
            properties: { name: "proj", organization_slug: "acme" },
          },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("does not re-identify groups when the linked-project cache already exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "linked-cache-hit-" });
      yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", ".temp", "linked-project.json"),
        yield* encodeJson({
          ref: VALID_REF,
          name: "proj",
          organization_id: "org-1",
          organization_slug: "acme",
        }),
      );
      const analytics = mockAnalytics();
      const api = mockCommandPlatformApi({
        handler: () => Effect.die("cache GET must not run on a cache hit"),
      });
      const identityStitch = identityStitchLayer.pipe(
        Layer.provide(analytics.layer),
        Layer.provide(
          mockTelemetryRuntime({ configDir: path.join(workdir, ".supabase"), consent: "granted" }),
        ),
        Layer.provide(BunServices.layer),
      );
      const layer = linkedProjectCacheLayer.pipe(
        Layer.provide(api.httpClientLayer),
        Layer.provide(mockCommandSettings({ workdir })),
        Layer.provide(mockCommandCredentialsLayer),
        Layer.provide(identityStitch),
        Layer.provide(analytics.layer),
        Layer.provide(BunServices.layer),
      );
      yield* Effect.gen(function* () {
        const cache = yield* LinkedProjectCache;
        yield* cache.cache(VALID_REF, workdir);
        expect(api.requests).toEqual([]);
        expect(analytics.groupIdentified).toEqual([]);
        expect(analytics.aliased).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "skips the fill when project-ref names a DIFFERENT ref: the cache must describe the linked workdir, not the resolved ref (PR #6168 review)",
    () =>
      Effect.gen(function* () {
        // A mid-flight `link --project-ref B` failure still reaches the fill via `Effect.ensuring`
        // while `project-ref` holds the old link — caching B would make the parent chain prefer a
        // never-linked project. The guard runs before any token/network work, so the GET must
        // never fire.
        const OTHER_REF = "otherprojectrefabcde";
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "linked-cache-diverge-" });
        yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", ".temp", "project-ref"),
          VALID_REF,
        );
        const analytics = mockAnalytics();
        const api = mockCommandPlatformApi({
          handler: () => Effect.die("cache GET must not run when project-ref diverges"),
        });
        const identityStitch = identityStitchLayer.pipe(
          Layer.provide(analytics.layer),
          Layer.provide(
            mockTelemetryRuntime({
              configDir: path.join(workdir, ".supabase"),
              consent: "granted",
            }),
          ),
          Layer.provide(BunServices.layer),
        );
        const layer = linkedProjectCacheLayer.pipe(
          Layer.provide(api.httpClientLayer),
          Layer.provide(mockCommandSettings({ workdir })),
          Layer.provide(mockCommandCredentialsLayer),
          Layer.provide(identityStitch),
          Layer.provide(analytics.layer),
          Layer.provide(BunServices.layer),
        );
        yield* Effect.gen(function* () {
          const cache = yield* LinkedProjectCache;
          yield* cache.cache(OTHER_REF, workdir);
          expect(
            yield* fs.exists(path.join(workdir, "supabase", ".temp", "linked-project.json")),
          ).toBe(false);
          expect(analytics.groupIdentified).toEqual([]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("leaves the command's result alone when the project lookup is forbidden", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "linked-cache-forbidden-" });
      const analytics = mockAnalytics();
      const api = mockCommandPlatformApi({
        response: { status: 403, body: { message: "Forbidden" } },
      });
      const identityStitch = identityStitchLayer.pipe(
        Layer.provide(analytics.layer),
        Layer.provide(
          mockTelemetryRuntime({ configDir: path.join(workdir, ".supabase"), consent: "granted" }),
        ),
        Layer.provide(BunServices.layer),
      );
      const layer = linkedProjectCacheLayer.pipe(
        Layer.provide(api.httpClientLayer),
        Layer.provide(mockCommandSettings({ workdir })),
        Layer.provide(mockCommandCredentialsLayer),
        Layer.provide(identityStitch),
        Layer.provide(analytics.layer),
        Layer.provide(BunServices.layer),
      );
      yield* Effect.gen(function* () {
        const cache = yield* LinkedProjectCache;
        yield* cache.cache(VALID_REF, workdir);
        expect(api.requests).toHaveLength(1);
        expect(
          yield* fs.exists(path.join(workdir, "supabase", ".temp", "linked-project.json")),
        ).toBe(false);
        expect(analytics.groupIdentified).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("keeps the stack-mode cache under SUPABASE_HOME and leaves supabase/.temp alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "linked-cache-stack-" });
      const analytics = mockAnalytics();
      const api = mockCommandPlatformApi({
        response: {
          status: 200,
          body: {
            ref: VALID_REF,
            id: VALID_REF,
            name: "proj",
            organization_id: "org-1",
            organization_slug: "acme",
            region: "us-east-1",
            created_at: "2026-01-01T00:00:00Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: "db.example.com",
              version: "15",
              postgres_engine: "15",
              release_channel: "ga",
            },
          },
        },
      });
      const identityStitch = identityStitchLayer.pipe(
        Layer.provide(analytics.layer),
        Layer.provide(
          mockTelemetryRuntime({ configDir: path.join(workdir, ".supabase"), consent: "granted" }),
        ),
        Layer.provide(BunServices.layer),
      );
      const layer = linkedProjectCacheLayer.pipe(
        Layer.provide(api.httpClientLayer),
        Layer.provide(mockCommandSettings({ workdir, supabaseHome: path.join(workdir, "home") })),
        Layer.provide(mockCommandCredentialsLayer),
        Layer.provide(identityStitch),
        Layer.provide(analytics.layer),
        Layer.provide(BunServices.layer),
      );
      yield* Effect.gen(function* () {
        const cache = yield* LinkedProjectCache;
        yield* cache.cache(VALID_REF, workdir);
        yield* cache.cache(VALID_REF, workdir);
        expect(
          yield* fs.readFileString(
            path.join(workdir, "home", "project-cache", `${VALID_REF}.json`),
          ),
        ).toBe(
          `{"ref":"${VALID_REF}","name":"proj","organization_id":"org-1","organization_slug":"acme"}`,
        );
        expect(api.requests).toHaveLength(1);
        expect(yield* fs.exists(path.join(workdir, "supabase", ".temp"))).toBe(false);
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(projectStateModeLayer("stack")))));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
