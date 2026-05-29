import type {
  V1ActivateVanitySubdomainConfigOutput,
  V1CheckVanitySubdomainAvailabilityOutput,
  V1GetVanitySubdomainConfigOutput,
} from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyVanitySubdomainsActivate } from "./activate/activate.handler.ts";
import { legacyVanitySubdomainsCheckAvailability } from "./check-availability/check-availability.handler.ts";
import { legacyVanitySubdomainsDelete } from "./delete/delete.handler.ts";
import { legacyVanitySubdomainsGet } from "./get/get.handler.ts";

type VanityConfig = typeof V1GetVanitySubdomainConfigOutput.Type;
type AvailabilityResponse = typeof V1CheckVanitySubdomainAvailabilityOutput.Type;
type ActivateResponse = typeof V1ActivateVanitySubdomainConfigOutput.Type;

const tempRoot = useLegacyTempWorkdir("supabase-vanity-int-");

const SAMPLE_GET: VanityConfig = {
  status: "custom-domain-used",
  custom_domain: "example.com",
};

const SAMPLE_CHECK: AvailabilityResponse = {
  available: true,
};

const SAMPLE_ACTIVATE: ActivateResponse = {
  custom_domain: "example.com",
};

describe("legacy vanity-subdomains integration", () => {
  type LegacyOutput = "env" | "pretty" | "json" | "toml" | "yaml";

  function runtimeWith(opts: {
    readonly out: ReturnType<typeof mockOutput>;
    readonly api: ReturnType<typeof mockLegacyPlatformApi>;
    readonly analytics?: ReturnType<typeof mockAnalytics>;
    readonly telemetry?: ReturnType<typeof mockLegacyTelemetryStateTracked>["layer"];
    readonly linkedProjectCache?: ReturnType<typeof mockLegacyLinkedProjectCacheTracked>["layer"];
    readonly legacyOutput?: LegacyOutput;
  }) {
    return buildLegacyTestRuntime({
      out: opts.out,
      api: opts.api,
      analytics: opts.analytics,
      cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      telemetry: opts.telemetry,
      linkedProjectCache: opts.linkedProjectCache,
      goOutput: opts.legacyOutput === undefined ? Option.none() : Option.some(opts.legacyOutput),
    });
  }

  it.live("gets the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: SAMPLE_GET },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("Status: custom-domain-used\nVanity subdomain: example.com\n");
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain`);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy TOML bytes for get", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: SAMPLE_GET },
    });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        'Status = "custom-domain-used"\nCustomDomain = "example.com"\n\n',
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("checks availability in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 201, body: SAMPLE_CHECK },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toBe("Subdomain example.com available: true\n");
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain/check-availability`,
      );
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "example.com" });
    }).pipe(Effect.provide(layer));
  });

  it.live("suggests upgrade for gated availability checks without firing analytics", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        Effect.sync(() => {
          if (request.method === "POST" && request.url.includes("/check-availability")) {
            return legacyJsonResponse(request, 402, {});
          }
          if (
            request.method === "GET" &&
            request.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)
          ) {
            return legacyJsonResponse(request, 200, { organization_slug: "supabase" });
          }
          if (request.method === "GET" && request.url.includes("/entitlements")) {
            return legacyJsonResponse(request, 200, {
              entitlements: [
                {
                  feature: { key: "vanity_subdomain", type: "boolean" },
                  hasAccess: false,
                  type: "boolean",
                  config: { enabled: true },
                },
              ],
            });
          }
          return legacyJsonResponse(request, 200, null);
        }),
    });
    const analytics = mockAnalytics();
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyVanitySubdomainsCheckAvailability({
          projectRef: Option.none(),
          desiredSubdomain: "example.com",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("activates the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 201, body: SAMPLE_ACTIVATE },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toBe("Activated vanity subdomain at example.com\n");
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain`);
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "example.com" });
    }).pipe(Effect.provide(layer));
  });

  it.live("suggests upgrade and fires analytics for gated activation", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        Effect.sync(() => {
          if (request.method === "POST" && request.url.includes("/vanity-subdomain")) {
            return legacyJsonResponse(request, 402, {});
          }
          if (
            request.method === "GET" &&
            request.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)
          ) {
            return legacyJsonResponse(request, 200, { organization_slug: "supabase" });
          }
          if (request.method === "GET" && request.url.includes("/entitlements")) {
            return legacyJsonResponse(request, 200, {
              entitlements: [
                {
                  feature: { key: "vanity_subdomain", type: "boolean" },
                  hasAccess: false,
                  type: "boolean",
                  config: { enabled: true },
                },
              ],
            });
          }
          return legacyJsonResponse(request, 200, null);
        }),
    });
    const analytics = mockAnalytics();
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyVanitySubdomainsActivate({
          projectRef: Option.none(),
          desiredSubdomain: "example.com",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "vanity_subdomain", org_slug: "supabase" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("deletes the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: null },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsDelete({ projectRef: Option.none() });
      expect(out.stderrText).toBe("Deleted vanity subdomain successfully.\n");
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain`);
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores legacy --output values on delete", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: null },
    });
    const layer = runtimeWith({ out, api, legacyOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsDelete({ projectRef: Option.none() });
      expect(out.stderrText).toBe("Deleted vanity subdomain successfully.\n");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: SAMPLE_GET },
    });
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
