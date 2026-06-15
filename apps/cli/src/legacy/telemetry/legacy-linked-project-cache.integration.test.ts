import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      const layer = legacyLinkedProjectCacheLayer.pipe(
        Layer.provide(api.httpClientLayer),
        Layer.provide(mockLegacyCliConfig({ workdir })),
        Layer.provide(mockLegacyCredentialsLayer),
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
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(layer));
    },
  );
});
