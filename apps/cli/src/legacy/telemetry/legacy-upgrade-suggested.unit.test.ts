import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { EventUpgradeSuggested } from "../../shared/telemetry/event-catalog.ts";
import { suggestUpgradeOnError } from "./legacy-upgrade-suggested.ts";

interface ApiOverrides {
  readonly project?: { ok: true; orgSlug: string } | { ok: false };
  readonly entitlements?:
    | { ok: true; features: ReadonlyArray<{ key: string; hasAccess: boolean }> }
    | { ok: false };
}

function mockApi(opts: ApiOverrides = {}) {
  const project = opts.project ?? { ok: true, orgSlug: "acme" };
  const ent = opts.entitlements ?? { ok: true, features: [] };

  return Layer.succeed(LegacyPlatformApi, {
    // We only care about the two endpoints suggestUpgradeOnError uses; the rest
    // throw if invoked so tests stay focused on the intended call surface.
    v1: {
      getProject: (_input: { ref: string }) =>
        project.ok
          ? Effect.succeed({
              id: "x",
              ref: "x",
              organization_id: "x",
              organization_slug: project.orgSlug,
              name: "x",
              region: "x",
              created_at: "x",
              status: "ACTIVE_HEALTHY",
              database: { host: "x", version: "x", postgres_engine: "x", release_channel: "x" },
            } as never)
          : Effect.fail("project lookup failed" as never),
      getOrganizationEntitlements: (_input: { slug: string }) =>
        ent.ok
          ? Effect.succeed({
              entitlements: ent.features.map((f) => ({
                feature: { key: f.key, type: "boolean" as const },
                hasAccess: f.hasAccess,
                type: "boolean" as const,
                config: { enabled: f.hasAccess },
              })),
            } as never)
          : Effect.fail("entitlements lookup failed" as never),
    },
  } as unknown as typeof LegacyPlatformApi.Service);
}

function mockAnalytics() {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  return {
    layer: Layer.succeed(Analytics, {
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.sync(() => {
          captured.push({ event, properties });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
    captured,
  };
}

describe("suggestUpgradeOnError", () => {
  it.live("fires cli_upgrade_suggested on 4xx + feature gated", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(
      mockApi({ entitlements: { ok: true, features: [{ key: "auth.saml_2", hasAccess: false }] } }),
      analytics.layer,
    );
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(1);
      expect(analytics.captured[0]?.event).toBe(EventUpgradeSuggested);
      expect(analytics.captured[0]?.properties).toEqual({
        feature_key: "auth.saml_2",
        org_slug: "acme",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("no event on 2xx", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(mockApi(), analytics.layer);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 200);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("no event on 5xx", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(mockApi(), analytics.layer);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 503);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("no event when entitlement has access", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(
      mockApi({ entitlements: { ok: true, features: [{ key: "auth.saml_2", hasAccess: true }] } }),
      analytics.layer,
    );
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("no event when feature key is missing from entitlements", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(
      mockApi({
        entitlements: { ok: true, features: [{ key: "other.feature", hasAccess: false }] },
      }),
      analytics.layer,
    );
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("swallows getProject transport failure silently", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(mockApi({ project: { ok: false } }), analytics.layer);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("swallows getOrganizationEntitlements transport failure silently", () => {
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(mockApi({ entitlements: { ok: false } }), analytics.layer);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
