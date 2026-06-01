import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { mockAnalytics, mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../tests/helpers/legacy-mocks.ts";
import { legacySuggestUpgrade } from "./legacy-upgrade-suggest.ts";

const ORG_SLUG = "test-org";

function projectResponse(slug: string = ORG_SLUG) {
  return {
    id: LEGACY_VALID_REF,
    ref: LEGACY_VALID_REF,
    organization_id: "org-123",
    organization_slug: slug,
    name: "Test Project",
    region: "us-east-1",
    created_at: "2026-01-01T00:00:00Z",
    status: "ACTIVE_HEALTHY",
    database: {
      host: "db.example.com",
      version: "15",
      postgres_engine: "15",
      release_channel: "ga",
    },
  };
}

function entitlementResponse(opts: { readonly featureKey: string; readonly hasAccess: boolean }) {
  return {
    entitlements: [
      {
        feature: { key: opts.featureKey, type: "boolean" as const },
        hasAccess: opts.hasAccess,
        type: "boolean" as const,
        config: { enabled: !opts.hasAccess },
      },
    ],
  };
}

const tempRoot = useLegacyTempWorkdir("supabase-upgrade-suggest-");

interface SetupOpts {
  readonly format?: "text" | "json";
  readonly projectStatus?: number;
  readonly entitlementsStatus?: number;
  readonly entitlementFeatureKey?: string;
  readonly entitlementHasAccess?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const projectStatus = opts.projectStatus ?? 200;
  const entitlementsStatus = opts.entitlementsStatus ?? 200;

  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });

  const api = mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
          return legacyJsonResponse(
            request,
            projectStatus,
            projectStatus === 200 ? projectResponse() : { error: "err" },
          );
        }
        if (request.url.includes("/entitlements")) {
          return legacyJsonResponse(
            request,
            entitlementsStatus,
            entitlementsStatus === 200
              ? entitlementResponse({
                  featureKey: opts.entitlementFeatureKey ?? "branching_limit",
                  hasAccess: opts.entitlementHasAccess ?? false,
                })
              : { error: "err" },
          );
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });

  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    analytics,
  });

  return { layer, out, analytics, api };
}

describe("legacySuggestUpgrade", () => {
  it.live("skips when status < 400 (success path)", () => {
    const { layer, out, analytics } = setup();
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 200,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips when status >= 500 (server error)", () => {
    const { layer, out, analytics } = setup();
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 503,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips when getProject fails", () => {
    const { layer, analytics, out } = setup({ projectStatus: 500 });
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips when getEntitlements fails", () => {
    const { layer, analytics, out } = setup({ entitlementsStatus: 500 });
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips when entitlement feature key does not match", () => {
    const { layer, analytics, out } = setup({ entitlementFeatureKey: "vanity_subdomain" });
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips when entitlement has access (not gated)", () => {
    const { layer, analytics, out } = setup({ entitlementHasAccess: true });
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested with {feature_key, org_slug} when gated", () => {
    const { layer, analytics, out } = setup();
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
      });
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "branching_limit", org_slug: ORG_SLUG },
        },
      ]);
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(out.stderrText).toContain("/org/test-org/billing");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not write to stderr in non-text output mode", () => {
    const { layer, analytics, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
      });
      expect(analytics.captured).toHaveLength(1);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips cli_upgrade_suggested analytics when trackAnalytics=false", () => {
    const { layer, analytics, out } = setup();
    return Effect.gen(function* () {
      yield* legacySuggestUpgrade({
        projectRef: LEGACY_VALID_REF,
        featureKey: "branching_limit",
        statusCode: 402,
        trackAnalytics: false,
      });
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).toContain("Upgrade your plan:");
    }).pipe(Effect.provide(layer));
  });
});
