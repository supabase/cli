import { type V1GetHostnameConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  transportFailure,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  unverifiedTargetBanner,
} from "../../../../tests/helpers/command-mocks.ts";
import { DomainsCnameError } from "../domains.errors.ts";
import { domainsCreate } from "./create.handler.ts";

const CUSTOM_HOSTNAME = "shop.acme.dev";
const EXPECTED_CNAME = `${VALID_REF}.supabase.co.`;

const HOSTNAME_RESPONSE: typeof V1GetHostnameConfigOutput.Type = {
  status: "4_origin_setup_completed",
  custom_hostname: CUSTOM_HOSTNAME,
  data: {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: "id-1",
      hostname: CUSTOM_HOSTNAME,
      ssl: { status: "active", validation_records: [] },
      ownership_verification: { type: "txt", name: "n", value: "v" },
      custom_origin_server: "abc.supabase.co",
      status: "active",
    },
  },
};

type OutputFlagValue = "env" | "pretty" | "json" | "toml" | "yaml";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly outputFlag?: OutputFlagValue;
  readonly cname?: "ok" | "transport-fail" | "no-cname" | "mismatch" | "status-error";
  readonly apiStatus?: number;
  readonly apiNetwork?: "fail";
  readonly apiResponse?: unknown;
  readonly dnsRequested?: Deferred.Deferred<void>;
}

const tempRoot = useTempWorkdir("supabase-domains-create-int-");

function setup(opts: SetupOpts = {}) {
  const cname = opts.cname ?? "ok";
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    handler: (request) => {
      if (request.url.includes("1.1.1.1")) {
        if (opts.dnsRequested !== undefined) {
          return Deferred.succeed(opts.dnsRequested, undefined).pipe(Effect.andThen(Effect.never));
        }
        if (cname === "transport-fail") {
          return Effect.fail(transportFailure(request));
        }
        if (cname === "status-error") {
          return Effect.succeed(jsonResponse(request, 500, { error: "dns down" }));
        }
        const answer =
          cname === "no-cname"
            ? [{ type: 1, data: "1.2.3.4" }]
            : [{ type: 5, data: cname === "mismatch" ? "wrong.example.com." : EXPECTED_CNAME }];
        return Effect.succeed(jsonResponse(request, 200, { Answer: answer }));
      }
      if (opts.apiNetwork === "fail") {
        return Effect.fail(transportFailure(request));
      }
      return Effect.succeed(
        jsonResponse(request, opts.apiStatus ?? 201, opts.apiResponse ?? HOSTNAME_RESPONSE),
      );
    },
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const analytics = mockAnalytics();
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    analytics,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api, analytics, telemetry, linkedProjectCache };
}

function flags() {
  return {
    projectRef: Option.none<string>(),
    customHostname: CUSTOM_HOSTNAME,
    includeRawOutput: Option.none<boolean>(),
  };
}

function postedToInitialize(api: { requests: ReadonlyArray<{ url: string }> }): boolean {
  return api.requests.some((r) => r.url.includes("/custom-hostname/initialize"));
}

describe("domains create integration", () => {
  it.effect("verifies the CNAME, creates the hostname, and prints status to stderr", () => {
    const { layer, out, api, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* domainsCreate(flags());
      expect(out.stderrText).toContain("Custom hostname configuration complete");
      expect(out.stdoutText).toBe("");
      expect(postedToInitialize(api)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests upgrade from entitlement_required envelope on 400", () => {
    const { layer, out, analytics, api } = setup({
      apiStatus: 400,
      apiResponse: {
        message:
          "Custom domains require the Custom Domain add-on, available on the Pro plan and above.",
        error: {
          code: "entitlement_required",
          feature: "custom_domain",
          upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
        },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(2);
      expect(postedToInitialize(api)).toBe(true);
      expect(out.stderrText).toContain("Upgrade your plan:");
      expect(out.stderrText).toContain("/org/env-org/billing");
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "custom_domain", org_slug: "env-org" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("plain 400 without envelope produces no upgrade hint", () => {
    const { layer, out, analytics, api } = setup({
      apiStatus: 400,
      apiResponse: { message: "invalid hostname" },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(2);
      expect(analytics.captured).toHaveLength(0);
      expect(out.stderrText).not.toContain("Upgrade your plan:");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails before any POST when the CNAME lookup transport fails", () => {
    const { layer, api } = setup({ cname: "transport-fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("DomainsCnameError");
        expect(causeText).toContain("but it failed to resolve");
      }
      expect(postedToInitialize(api)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a transport CNAME error before any POST when the lookup times out", () =>
    Effect.gen(function* () {
      const dnsRequested = yield* Deferred.make<void>();
      const { layer, api } = setup({ dnsRequested });
      const fiber = yield* domainsCreate(flags()).pipe(
        Effect.provide(layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(dnsRequested);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(DomainsCnameError);
      expect(error).toMatchObject({
        transport: true,
        message: expect.stringContaining("but it failed to resolve: Operation timed out after"),
      });
      expect(postedToInitialize(api)).toBe(false);
    }),
  );

  it.effect("fails before any POST when no CNAME record resolves", () => {
    const { layer, api } = setup({ cname: "no-cname" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("failed to locate appropriate CNAME record");
      }
      expect(postedToInitialize(api)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails before any POST when the CNAME points elsewhere", () => {
    const { layer, api, telemetry } = setup({ cname: "mismatch" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "but it is currently set to 'wrong.example.com.'",
        );
      }
      expect(postedToInitialize(api)).toBe(false);
      // PersistentPostRun still fires even when the CNAME check fails.
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails before any POST when the DNS query returns a non-200 status", () => {
    const { layer, api } = setup({ cname: "status-error" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("but it failed to resolve");
        expect(causeText).toContain("unexpected DNS query status 500");
      }
      expect(postedToInitialize(api)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits indented JSON to stdout with no status on stderr for -o json", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* domainsCreate(flags());
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stderrText).toBe(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML to stdout with no status on stderr for -o yaml", () => {
    const { layer, out } = setup({ outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* domainsCreate(flags());
      // YAML output lowercases the whole field name.
      expect(out.stdoutText).toContain(`customhostname: ${CUSTOM_HOSTNAME}`);
      expect(out.stderrText).toBe(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured success object for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* domainsCreate(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ custom_hostname: CUSTOM_HOSTNAME });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DomainsUnexpectedStatusError when the API returns 503", () => {
    const { layer } = setup({ apiStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("unexpected create hostname status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DomainsNetworkError when the create request fails", () => {
    const { layer } = setup({ apiNetwork: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("failed to create custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps an API error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", apiStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
