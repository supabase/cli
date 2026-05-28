import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { EventUpgradeSuggested } from "../../shared/telemetry/event-catalog.ts";
import { suggestUpgradeOnError } from "./legacy-upgrade-suggested.ts";

interface FixtureOverrides {
  readonly project?: { ok: true; orgSlug: string } | { ok: false; status: number };
  readonly entitlements?:
    | { ok: true; features: ReadonlyArray<{ key: string; hasAccess: boolean }> }
    | { ok: false; status: number };
}

function jsonResponse(
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function mockHttp(opts: FixtureOverrides = {}) {
  const project = opts.project ?? { ok: true, orgSlug: "acme" };
  const ent = opts.entitlements ?? { ok: true, features: [] };
  const requests: Array<{ url: string; method: string }> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ url: request.url, method: request.method });
      if (request.url.includes("/v1/projects/")) {
        if (project.ok) {
          return Effect.succeed(
            jsonResponse(request, 200, {
              id: "x",
              ref: "aaaaaaaaaaaaaaaaaaaa",
              organization_id: "x",
              organization_slug: project.orgSlug,
              name: "x",
              region: "us-east-1",
              created_at: "2000-01-01T00:00:00Z",
              status: "ACTIVE_HEALTHY",
              database: {
                host: "x",
                version: "17",
                postgres_engine: "17",
                release_channel: "ga",
              },
            }),
          );
        }
        return Effect.succeed(jsonResponse(request, project.status, { message: "fail" }));
      }
      if (request.url.includes("/entitlements")) {
        if (ent.ok) {
          return Effect.succeed(
            jsonResponse(request, 200, {
              entitlements: ent.features.map((f) => ({
                feature: { key: f.key, type: "boolean" },
                hasAccess: f.hasAccess,
                type: "boolean",
                config: { enabled: f.hasAccess },
              })),
            }),
          );
        }
        return Effect.succeed(jsonResponse(request, ent.status, { message: "fail" }));
      }
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: `Unexpected URL in test: ${request.url}`,
          }),
        }),
      );
    }),
  );
  return { layer, requests };
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

const mockCliConfig = Layer.succeed(LegacyCliConfig, {
  profile: "supabase",
  apiUrl: "https://api.test",
  accessToken: Option.some(Redacted.make("sbp_" + "a".repeat(40))),
  projectId: Option.some("aaaaaaaaaaaaaaaaaaaa"),
  workdir: "/tmp/test",
  userAgent: "SupabaseCLI/0.0.0",
});

const mockCredentials = Layer.succeed(LegacyCredentials, {
  getAccessToken: Effect.succeed(Option.none()),
  saveAccessToken: () => Effect.die("unexpected"),
  deleteAccessToken: Effect.die("unexpected"),
});

describe("suggestUpgradeOnError", () => {
  it.live("fires cli_upgrade_suggested on 4xx + feature gated", () => {
    const analytics = mockAnalytics();
    const http = mockHttp({
      entitlements: { ok: true, features: [{ key: "auth.saml_2", hasAccess: false }] },
    });
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("aaaaaaaaaaaaaaaaaaaa", "auth.saml_2", 404);
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
    const http = mockHttp();
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 200);
      expect(analytics.captured).toHaveLength(0);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("no event on 5xx", () => {
    const analytics = mockAnalytics();
    const http = mockHttp();
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 503);
      expect(analytics.captured).toHaveLength(0);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("no event when entitlement has access", () => {
    const analytics = mockAnalytics();
    const http = mockHttp({
      entitlements: { ok: true, features: [{ key: "auth.saml_2", hasAccess: true }] },
    });
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("no event when feature key is missing from entitlements", () => {
    const analytics = mockAnalytics();
    const http = mockHttp({
      entitlements: { ok: true, features: [{ key: "other.feature", hasAccess: false }] },
    });
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("swallows getProject non-200 silently", () => {
    const analytics = mockAnalytics();
    const http = mockHttp({ project: { ok: false, status: 401 } });
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
      // Only the project request fires; entitlements never reached.
      expect(http.requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("swallows getOrganizationEntitlements non-200 silently", () => {
    const analytics = mockAnalytics();
    const http = mockHttp({ entitlements: { ok: false, status: 500 } });
    const layer = Layer.mergeAll(http.layer, analytics.layer, mockCliConfig, mockCredentials);
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("ref", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(0);
      // Both calls fire; only the analytics capture is skipped.
      expect(http.requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.live("regression: tolerates placeholder `__PROJECT_REF__` in response body", () => {
    // Mimics cli-e2e replay fixtures which retain the literal placeholder string
    // in response bodies — the typed client's strict `ref: isMinLength(20)`
    // schema would reject this; raw-HTTP path is permissive.
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.url.includes("/v1/projects/")) {
            return Effect.succeed(
              jsonResponse(request, 200, {
                // ref is the 15-char placeholder — typed schema would fail here.
                id: "x",
                ref: "__PROJECT_REF__",
                organization_id: "__PROJECT_REF__",
                organization_slug: "__PROJECT_REF__",
                name: "x",
                region: "us-east-1",
                created_at: "2000-01-01T00:00:00Z",
                status: "ACTIVE_HEALTHY",
                database: {
                  host: "x",
                  version: "17",
                  postgres_engine: "17",
                  release_channel: "ga",
                },
              }),
            );
          }
          return Effect.succeed(
            jsonResponse(request, 200, {
              entitlements: [
                {
                  feature: { key: "auth.saml_2", type: "boolean" },
                  hasAccess: false,
                  type: "boolean",
                  config: { enabled: false },
                },
              ],
            }),
          );
        }),
      ),
      analytics.layer,
      mockCliConfig,
      mockCredentials,
    );
    return Effect.gen(function* () {
      yield* suggestUpgradeOnError("aaaaaaaaaaaaaaaaaaaa", "auth.saml_2", 404);
      expect(analytics.captured).toHaveLength(1);
      expect(analytics.captured[0]?.properties).toEqual({
        feature_key: "auth.saml_2",
        org_slug: "__PROJECT_REF__",
      });
    }).pipe(Effect.provide(layer));
  });
});
