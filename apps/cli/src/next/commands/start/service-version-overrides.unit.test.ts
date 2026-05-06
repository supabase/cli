import { DEFAULT_VERSIONS } from "@supabase/stack/effect";
import { describe, expect, test } from "vitest";
import { Effect, Layer } from "effect";
import {
  mockProjectLinkState,
  mockProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";
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
    const candidateBaseline = {
      ...DEFAULT_VERSIONS,
      postgres: "17.6.1.090",
      postgrest: "14.5",
      auth: "2.187.0",
    };

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
      candidateBaseline,
      pinnedBaseline: candidateBaseline,
      runtimeVersions: {
        ...candidateBaseline,
        postgres: "17.4.1.045",
        auth: "2.170.0",
        storage: "1.40.0",
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
