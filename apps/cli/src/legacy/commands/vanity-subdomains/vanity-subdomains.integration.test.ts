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

// A project with no vanity subdomain configured — `custom_domain` is absent.
const SAMPLE_GET_NO_DOMAIN: VanityConfig = {
  status: "not-used",
};

const SAMPLE_CHECK: AvailabilityResponse = {
  available: true,
};

const SAMPLE_ACTIVATE: ActivateResponse = {
  custom_domain: "example.com",
};

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

// Builds an API mock where the given write endpoint is billing-gated (402) and
// the project/entitlements lookups report no access to `vanity_subdomain`. Used
// to exercise the upgrade-suggestion branch in `activate` and `check-availability`.
function gatedApi(matchWrite: (url: string) => boolean) {
  return mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && matchWrite(request.url)) {
          return legacyJsonResponse(request, 402, {});
        }
        if (request.method === "GET" && request.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
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
}

describe("legacy vanity-subdomains get", () => {
  it.live("prints status and subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("Status: custom-domain-used\nVanity subdomain: example.com\n");
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain`);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the subdomain line in text mode when none is configured", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET_NO_DOMAIN } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("Status: not-used\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy JSON bytes for --output json", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, legacyOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('"status": "custom-domain-used"');
      expect(out.stdoutText).toContain('"custom_domain": "example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy YAML for --output yaml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, legacyOutput: "yaml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("status: custom-domain-used");
      expect(out.stdoutText).toContain("custom_domain: example.com");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        'Status = "custom-domain-used"\nCustomDomain = "example.com"\n\n',
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("omits CustomDomain in TOML when none is configured", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET_NO_DOMAIN } });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe('Status = "not-used"\n\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy env for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, legacyOutput: "env" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('STATUS="custom-domain-used"');
      expect(out.stdoutText).toContain('CUSTOM_DOMAIN="example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ status: "custom-domain-used" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format stream-json", () => {
    const out = mockOutput({ format: "stream-json" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ status: "custom-domain-used" });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with an unexpected-status error on HTTP 503", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 503, body: {} } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyVanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyVanitySubdomainsGetUnexpectedStatusError");
        expect(errorJson).toContain("unexpected vanity subdomain status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.live("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyVanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyVanitySubdomainsGetNetworkError");
        expect(errorJson).toContain("failed to get vanity subdomain");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy vanity-subdomains check-availability", () => {
  it.live("prints availability in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
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

  it.live("emits legacy JSON bytes for --output json", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, legacyOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toContain('"available": true');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy YAML for --output yaml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, legacyOutput: "yaml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toContain("available: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toBe("Available = true\n\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy env for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, legacyOutput: "env" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toContain('AVAILABLE="true"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ available: true });
    }).pipe(Effect.provide(layer));
  });

  it.live("suggests upgrade for gated checks without firing analytics", () => {
    const out = mockOutput({ format: "text" });
    const api = gatedApi((url) => url.includes("/check-availability"));
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

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.live("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyVanitySubdomainsCheckAvailability({
          projectRef: Option.none(),
          desiredSubdomain: "example.com",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyVanitySubdomainsCheckNetworkError");
        expect(errorJson).toContain("failed to check vanity subdomain");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy vanity-subdomains activate", () => {
  it.live("activates the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toBe("Activated vanity subdomain at example.com\n");
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain/activate`,
      );
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "example.com" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy JSON bytes for --output json", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, legacyOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toContain('"custom_domain": "example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy YAML for --output yaml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, legacyOutput: "yaml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toContain("custom_domain: example.com");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toBe('CustomDomain = "example.com"\n\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy env for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, legacyOutput: "env" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      expect(out.stdoutText).toContain('CUSTOM_DOMAIN="example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: "example.com",
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ custom_domain: "example.com" });
    }).pipe(Effect.provide(layer));
  });

  it.live("suggests upgrade and fires analytics for gated activation", () => {
    const out = mockOutput({ format: "text" });
    const api = gatedApi((url) => url.endsWith("/vanity-subdomain/activate"));
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

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.live("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });
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
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyVanitySubdomainsActivateNetworkError");
        expect(errorJson).toContain("failed activate vanity subdomain");
      }
      // A network failure is not a billing gate, so no upgrade is suggested.
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy vanity-subdomains delete", () => {
  it.live("deletes the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsDelete({ projectRef: Option.none() });
      expect(out.stderrText).toBe("Deleted vanity subdomain successfully.\n");
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/vanity-subdomain`);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsDelete({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Deleted vanity subdomain successfully.");
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores legacy --output values and prints to stderr", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
    const layer = runtimeWith({ out, api, legacyOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyVanitySubdomainsDelete({ projectRef: Option.none() });
      expect(out.stderrText).toBe("Deleted vanity subdomain successfully.\n");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with an unexpected-status error on HTTP 503", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 503, body: {} } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyVanitySubdomainsDelete({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyVanitySubdomainsDeleteUnexpectedStatusError");
        expect(errorJson).toContain("unexpected delete vanity subdomain status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.live("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyVanitySubdomainsDelete({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyVanitySubdomainsDeleteNetworkError");
        expect(errorJson).toContain("failed to delete vanity subdomain");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy vanity-subdomains PersistentPostRun parity", () => {
  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
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

  it.live("flushes telemetry and writes linked-project cache on failure", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 503, body: {} } });
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyVanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
