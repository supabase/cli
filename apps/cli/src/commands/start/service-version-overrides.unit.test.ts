import { describe, expect, test } from "vitest";
import { Effect, Layer } from "effect";
import {
  mockProjectLinkState,
  mockProjectLocalServiceVersions,
} from "../../../tests/helpers/mocks.ts";
import {
  parseServiceVersionOverrides,
  resolveServiceVersionContext,
} from "../../config/service-version-resolution.ts";

describe("service version overrides", () => {
  test("parses and normalizes repeated flag overrides", async () => {
    await expect(
      Effect.runPromise(
        parseServiceVersionOverrides(["postgrest=v14.5", "mailpit=1.22.3", "auth=2.180.0"]),
      ),
    ).resolves.toEqual({
      postgrest: "14.5",
      mailpit: "v1.22.3",
      auth: "2.180.0",
    });
  });

  test("resolves flag > local file > link state precedence", async () => {
    const layer = Layer.mergeAll(
      mockProjectLinkState({
        project: {
          ref: "abcdefghijklmnopqrst",
          name: "Test Project",
          organization_id: "org_123",
          organization_slug: "supabase",
        },
        active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
        fetchedAt: "2026-03-20T12:00:00.000Z",
        versions: {
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
        },
      }),
      mockProjectLocalServiceVersions({
        updatedAt: "2026-03-20T12:05:00.000Z",
        versions: {
          auth: "v2.180.0",
          storage: "1.40.0",
        },
      }),
    );

    await expect(
      Effect.runPromise(
        resolveServiceVersionContext(["auth=v2.170.0", "postgres=17.4.1.045"]).pipe(
          Effect.provide(layer),
        ),
      ),
    ).resolves.toEqual({
      candidateBaseline: {
        postgres: "17.6.1.090",
        postgrest: "14.5",
        auth: "2.187.0",
        realtime: "2.78.10",
        storage: "1.41.8",
        imgproxy: "v3.8.0",
        mailpit: "v1.22.3",
        pgmeta: "0.96.1",
        studio: "2026.03.04-sha-0043607",
        analytics: "1.34.7",
        vector: "0.28.1-alpine",
        pooler: "2.7.4",
      },
      pinnedBaseline: {
        postgres: "17.6.1.090",
        postgrest: "14.5",
        auth: "2.187.0",
        realtime: "2.78.10",
        storage: "1.41.8",
        imgproxy: "v3.8.0",
        mailpit: "v1.22.3",
        pgmeta: "0.96.1",
        studio: "2026.03.04-sha-0043607",
        analytics: "1.34.7",
        vector: "0.28.1-alpine",
        pooler: "2.7.4",
      },
      runtimeVersions: {
        postgres: "17.4.1.045",
        postgrest: "14.5",
        auth: "2.170.0",
        realtime: "2.78.10",
        storage: "1.40.0",
        imgproxy: "v3.8.0",
        mailpit: "v1.22.3",
        pgmeta: "0.96.1",
        studio: "2026.03.04-sha-0043607",
        analytics: "1.34.7",
        vector: "0.28.1-alpine",
        pooler: "2.7.4",
      },
      activeOverrides: [
        { service: "postgres", version: "17.4.1.045", source: "flag" },
        { service: "auth", version: "2.170.0", source: "flag" },
        { service: "storage", version: "1.40.0", source: "local" },
      ],
      availableUpdates: [],
      updateFingerprint: undefined,
    });
  });
});
