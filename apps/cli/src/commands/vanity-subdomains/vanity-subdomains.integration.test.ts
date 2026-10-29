import type {
  V1ActivateVanitySubdomainConfigOutput,
  V1CheckVanitySubdomainAvailabilityOutput,
  V1GetVanitySubdomainConfigOutput,
} from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockAnalytics, mockOutput, mockTty } from "../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../tests/helpers/permission-real-layers.ts";
import { vanitySubdomainsActivate } from "./activate/activate.handler.ts";
import { vanitySubdomainsCheckAvailability } from "./check-availability/check-availability.handler.ts";
import { vanitySubdomainsDelete } from "./delete/delete.handler.ts";
import { vanitySubdomainsGet } from "./get/get.handler.ts";
import { classifyCliCauseActionability } from "../../shared/telemetry/error-actionability.ts";

type VanityConfig = typeof V1GetVanitySubdomainConfigOutput.Type;
type AvailabilityResponse = typeof V1CheckVanitySubdomainAvailabilityOutput.Type;
type ActivateResponse = typeof V1ActivateVanitySubdomainConfigOutput.Type;

const tempRoot = useTempWorkdir("supabase-vanity-int-");

const API_URL = "https://api.supabase.com";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const requestLines = (api: ReturnType<typeof mockCommandPlatformApi>) =>
  api.requests.map(({ method, url }) => `${method} ${url}`);

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

const VANITY_GATE_ENVELOPE = {
  message: "This feature requires the Pro, Team, or Enterprise organization plan.",
  error: {
    code: "entitlement_required",
    feature: "vanity_subdomain",
    upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
  },
};

type GoOutput = "env" | "pretty" | "json" | "toml" | "yaml";

function runtimeWith(opts: {
  readonly out: ReturnType<typeof mockOutput>;
  readonly api: ReturnType<typeof mockCommandPlatformApi>;
  readonly analytics?: ReturnType<typeof mockAnalytics>;
  readonly telemetry?: ReturnType<typeof mockTelemetryStateTracked>["layer"];
  readonly linkedProjectCache?: ReturnType<typeof mockLinkedProjectCacheTracked>["layer"];
  readonly goOutput?: GoOutput;
}) {
  return buildTestRuntime({
    out: opts.out,
    api: opts.api,
    analytics: opts.analytics,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    telemetry: opts.telemetry,
    linkedProjectCache: opts.linkedProjectCache,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
}

// No project is configured: the picker lists projects, the command makes its own call, and the
// real linked-project cache then looks the project up.
function pickerComposition(own: { readonly status: number; readonly body: unknown }) {
  const out = mockOutput({ promptSelectResponses: [VALID_REF] });
  const api = mockCommandPlatformApi({
    handler: (request) => {
      if (request.method === "GET" && request.url === `${API_URL}/v1/projects`) {
        return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
      }
      if (request.method === "GET" && request.url === `${API_URL}/v1/projects/${VALID_REF}`) {
        return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
      }
      return Effect.succeed(jsonResponse(request, own.status, own.body));
    },
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current, projectId: Option.none() });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    tty: mockTty({ stdinIsTty: true }),
    linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
  });
  return { out, api, layer };
}

const linkedProjectCachePath = () => `${tempRoot.current}/supabase/.temp/linked-project.json`;

describe("vanity-subdomains get", () => {
  it.effect("prints status and subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("Status: custom-domain-used\nVanity subdomain: example.com\n");
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/vanity-subdomain`);
      assertPermissionDrift({
        command: "vanity-subdomains get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, reads the config and fills the real cache", () => {
    const { out, api, layer } = pickerComposition({ status: 200, body: SAMPLE_GET });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(linkedProjectCachePath())).toBe(false);
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(requestLines(api)).toEqual([
        `GET ${API_URL}/v1/projects`,
        `GET ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain`,
        `GET ${API_URL}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe("Status: custom-domain-used\nVanity subdomain: example.com\n");
      expect(yield* decodeJson(yield* fs.readFileString(linkedProjectCachePath()))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "vanity-subdomains get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests upgrade from entitlement_required envelope on 400", () => {
    const out = mockOutput({ format: "text" });
    const analytics = mockAnalytics();
    const api = mockCommandPlatformApi({
      response: {
        status: 400,
        body: {
          message: "This feature requires the Pro, Team, or Enterprise organization plan.",
          error: {
            code: "entitlement_required",
            feature: "vanity_subdomain",
            upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
          },
        },
      },
    });
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(1);
      assertPermissionDrift({ command: "vanity-subdomains get", requests: api.requests });
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(out.stderrText).toContain("/org/env-org/billing");
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "vanity_subdomain", org_slug: "env-org" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("plain 404 without envelope produces no upgrade hint", () => {
    const out = mockOutput({ format: "text" });
    const analytics = mockAnalytics();
    const api = mockCommandPlatformApi({
      response: { status: 404, body: { message: "not found" } },
    });
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(1);
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).not.toContain("Upgrade your plan:");
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits the subdomain line in text mode when none is configured", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET_NO_DOMAIN } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("Status: not-used\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits JSON bytes for --output json", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, goOutput: "json" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('"status": "custom-domain-used"');
      expect(out.stdoutText).toContain('"custom_domain": "example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML for --output yaml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, goOutput: "yaml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("status: custom-domain-used");
      // yaml.v3 lowercases the whole field name.
      expect(out.stdoutText).toContain("customdomain: example.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, goOutput: "toml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      // CustomDomain precedes Status, with a single trailing newline.
      expect(out.stdoutText).toBe('CustomDomain = "example.com"\nStatus = "custom-domain-used"\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits CustomDomain in TOML when none is configured", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET_NO_DOMAIN } });
    const layer = runtimeWith({ out, api, goOutput: "toml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe('Status = "not-used"\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits env for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api, goOutput: "env" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('STATUS="custom-domain-used"');
      expect(out.stdoutText).toContain('CUSTOM_DOMAIN="example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ status: "custom-domain-used" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event for --output-format stream-json", () => {
    const out = mockOutput({ format: "stream-json" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ status: "custom-domain-used" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with an unexpected-status error on HTTP 503", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 503, body: {} } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("VanitySubdomainsGetUnexpectedStatusError");
        expect(causeText).toContain("unexpected vanity subdomain status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.effect("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("VanitySubdomainsGetNetworkError");
        expect(causeText).toContain("failed to get vanity subdomain");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("vanity-subdomains check-availability", () => {
  it.effect("prints availability in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toBe("Subdomain example.com available: true\n");
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${VALID_REF}/vanity-subdomain/check-availability`,
      );
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "example.com" });
      assertPermissionDrift({
        command: "vanity-subdomains check-availability",
        activeFlags: { "desired-subdomain": "example.com" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, checks availability and fills the real cache", () => {
    const { out, api, layer } = pickerComposition({ status: 201, body: SAMPLE_CHECK });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(linkedProjectCachePath())).toBe(false);
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(requestLines(api)).toEqual([
        `GET ${API_URL}/v1/projects`,
        `POST ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/check-availability`,
        `GET ${API_URL}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe("Subdomain example.com available: true\n");
      expect(yield* decodeJson(yield* fs.readFileString(linkedProjectCachePath()))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "vanity-subdomains check-availability",
        activeFlags: { "desired-subdomain": "example.com" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits JSON bytes for --output json", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, goOutput: "json" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toContain('"available": true');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML for --output yaml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, goOutput: "yaml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toContain("available: true");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, goOutput: "toml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toBe("Available = true\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits env for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api, goOutput: "env" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toContain('AVAILABLE="true"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ available: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests upgrade for gated checks without firing analytics", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 400, body: VANITY_GATE_ENVELOPE } });
    const analytics = mockAnalytics();
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        vanitySubdomainsCheckAvailability({
          projectRef: Option.none(),
          desiredSubdomain: Option.some("example.com"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(out.stderrText).toContain("/org/env-org/billing");
      expect(analytics.captured).toHaveLength(0);
      expect(requestLines(api)).toEqual([
        `POST ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/check-availability`,
      ]);
      assertPermissionDrift({
        command: "vanity-subdomains check-availability",
        activeFlags: { "desired-subdomain": "example.com" },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("makes one request and suggests no upgrade on a check 4xx without the envelope", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      response: { status: 400, body: { message: "Invalid subdomain" } },
    });
    const analytics = mockAnalytics();
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        vanitySubdomainsCheckAvailability({
          projectRef: Option.none(),
          desiredSubdomain: Option.some("example.com"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(classifyCliCauseActionability(exit.cause).error_category).not.toBe("plan_limit");
      }
      expect(requestLines(api)).toEqual([
        `POST ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/check-availability`,
      ]);
      expect(out.stderrText).not.toContain("Upgrade your plan:");
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.effect("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        vanitySubdomainsCheckAvailability({
          projectRef: Option.none(),
          desiredSubdomain: Option.some("example.com"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("VanitySubdomainsCheckNetworkError");
        expect(causeText).toContain("failed to check vanity subdomain");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with cobra's required-flag error when --desired-subdomain is omitted", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        vanitySubdomainsCheckAvailability({
          projectRef: Option.none(),
          desiredSubdomain: Option.none(),
        }),
      );
      expect(error._tag).toBe("DesiredSubdomainRequiredError");
      expect(error.message).toBe('required flag(s) "desired-subdomain" not set');
      expect(api.requests).toHaveLength(0);
      expect(() =>
        assertPermissionDrift({
          command: "vanity-subdomains check-availability",
          activeFlags: {},
          requests: [
            {
              method: "POST",
              url: `${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/check-availability`,
            },
          ],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes an explicit empty --desired-subdomain through to the API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_CHECK } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsCheckAvailability({
        projectRef: Option.none(),
        desiredSubdomain: Option.some(""),
      });
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "" });
      expect(out.stdoutText).toBe("Subdomain  available: true\n");
      assertPermissionDrift({
        command: "vanity-subdomains check-availability",
        activeFlags: { "desired-subdomain": "" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("vanity-subdomains activate", () => {
  it.effect("activates the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toBe("Activated vanity subdomain at example.com\n");
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/vanity-subdomain/activate`);
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "example.com" });
      assertPermissionDrift({
        command: "vanity-subdomains activate",
        activeFlags: { "desired-subdomain": "example.com" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, activates the subdomain and fills the real cache", () => {
    const { out, api, layer } = pickerComposition({ status: 201, body: SAMPLE_ACTIVATE });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(linkedProjectCachePath())).toBe(false);
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(requestLines(api)).toEqual([
        `GET ${API_URL}/v1/projects`,
        `POST ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/activate`,
        `GET ${API_URL}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe("Activated vanity subdomain at example.com\n");
      expect(yield* decodeJson(yield* fs.readFileString(linkedProjectCachePath()))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "vanity-subdomains activate",
        activeFlags: { "desired-subdomain": "example.com" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits JSON bytes for --output json", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, goOutput: "json" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toContain('"custom_domain": "example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML for --output yaml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, goOutput: "yaml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      // yaml.v3 lowercases the whole field name.
      expect(out.stdoutText).toContain("customdomain: example.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, goOutput: "toml" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toBe('CustomDomain = "example.com"\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits env for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api, goOutput: "env" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      expect(out.stdoutText).toContain('CUSTOM_DOMAIN="example.com"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some("example.com"),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ custom_domain: "example.com" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests upgrade and fires analytics for gated activation", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 400, body: VANITY_GATE_ENVELOPE } });
    const analytics = mockAnalytics();
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        vanitySubdomainsActivate({
          projectRef: Option.none(),
          desiredSubdomain: Option.some("example.com"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(out.stderrText).toContain("/org/env-org/billing");
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "vanity_subdomain", org_slug: "env-org" },
        },
      ]);
      expect(requestLines(api)).toEqual([
        `POST ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/activate`,
      ]);
      assertPermissionDrift({
        command: "vanity-subdomains activate",
        activeFlags: { "desired-subdomain": "example.com" },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "makes one request and suggests no upgrade on an activate 4xx without the envelope",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        response: { status: 400, body: { message: "Invalid subdomain" } },
      });
      const analytics = mockAnalytics();
      const layer = runtimeWith({ out, api, analytics });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          vanitySubdomainsActivate({
            projectRef: Option.none(),
            desiredSubdomain: Option.some("example.com"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(classifyCliCauseActionability(exit.cause).error_category).not.toBe("plan_limit");
        }
        expect(requestLines(api)).toEqual([
          `POST ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/activate`,
        ]);
        expect(out.stderrText).not.toContain("Upgrade your plan:");
        expect(analytics.captured).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.effect("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ network: "fail" });
    const analytics = mockAnalytics();
    const layer = runtimeWith({ out, api, analytics });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        vanitySubdomainsActivate({
          projectRef: Option.none(),
          desiredSubdomain: Option.some("example.com"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("VanitySubdomainsActivateNetworkError");
        expect(causeText).toContain("failed activate vanity subdomain");
      }
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with cobra's required-flag error when --desired-subdomain is omitted", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        vanitySubdomainsActivate({
          projectRef: Option.none(),
          desiredSubdomain: Option.none(),
        }),
      );
      expect(error._tag).toBe("DesiredSubdomainRequiredError");
      expect(error.message).toBe('required flag(s) "desired-subdomain" not set');
      expect(api.requests).toHaveLength(0);
      expect(() =>
        assertPermissionDrift({
          command: "vanity-subdomains activate",
          activeFlags: {},
          requests: [
            {
              method: "POST",
              url: `${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain/activate`,
            },
          ],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes an explicit empty --desired-subdomain through to the API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsActivate({
        projectRef: Option.none(),
        desiredSubdomain: Option.some(""),
      });
      expect(api.requests[0]?.body).toEqual({ vanity_subdomain: "" });
      assertPermissionDrift({
        command: "vanity-subdomains activate",
        activeFlags: { "desired-subdomain": "" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("vanity-subdomains delete", () => {
  it.effect("deletes the vanity subdomain in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsDelete({ projectRef: Option.none() });
      expect(out.stderrText).toBe("Deleted vanity subdomain successfully.\n");
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/vanity-subdomain`);
      assertPermissionDrift({
        command: "vanity-subdomains delete",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, deletes the subdomain and fills the real cache", () => {
    const { out, api, layer } = pickerComposition({ status: 200, body: null });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(linkedProjectCachePath())).toBe(false);
      yield* vanitySubdomainsDelete({ projectRef: Option.none() });
      expect(requestLines(api)).toEqual([
        `GET ${API_URL}/v1/projects`,
        `DELETE ${API_URL}/v1/projects/${VALID_REF}/vanity-subdomain`,
        `GET ${API_URL}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stderrText).toContain("Deleted vanity subdomain successfully.\n");
      expect(yield* decodeJson(yield* fs.readFileString(linkedProjectCachePath()))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "vanity-subdomains delete",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* vanitySubdomainsDelete({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Deleted vanity subdomain successfully.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores --output values and prints to stderr", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const layer = runtimeWith({ out, api, goOutput: "json" });

    return Effect.gen(function* () {
      yield* vanitySubdomainsDelete({ projectRef: Option.none() });
      expect(out.stderrText).toBe("Deleted vanity subdomain successfully.\n");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with an unexpected-status error on HTTP 503", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 503, body: {} } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsDelete({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("VanitySubdomainsDeleteUnexpectedStatusError");
        expect(causeText).toContain("unexpected delete vanity subdomain status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  // json mode so the spinner is suppressed — exercises the no-task error path.
  it.effect("fails with a network error on transport failure", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsDelete({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("VanitySubdomainsDeleteNetworkError");
        expect(causeText).toContain("failed to delete vanity subdomain");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("vanity-subdomains PersistentPostRun parity", () => {
  it.effect("flushes telemetry and writes linked-project cache on success", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_GET } });
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      yield* vanitySubdomainsGet({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache on failure", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 503, body: {} } });
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(vanitySubdomainsGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // The desired-subdomain check runs inside both `Effect.ensuring` wrappers, so telemetry
  // still flushes and the cache still writes even though it fails before any API call.
  it.effect(
    "flushes telemetry and writes linked-project cache on a missing --desired-subdomain",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({ response: { status: 201, body: SAMPLE_ACTIVATE } });
      const telemetry = mockTelemetryStateTracked();
      const cache = mockLinkedProjectCacheTracked();
      const layer = runtimeWith({
        out,
        api,
        telemetry: telemetry.layer,
        linkedProjectCache: cache.layer,
      });

      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          vanitySubdomainsActivate({
            projectRef: Option.none(),
            desiredSubdomain: Option.none(),
          }),
        );
        expect(error._tag).toBe("DesiredSubdomainRequiredError");
        expect(telemetry.flushed).toBe(true);
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
});
