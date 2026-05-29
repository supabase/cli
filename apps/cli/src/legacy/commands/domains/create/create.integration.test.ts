import { type V1GetHostnameConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyDomainsCreate } from "./create.handler.ts";

const CUSTOM_HOSTNAME = "shop.acme.dev";
const EXPECTED_CNAME = `${LEGACY_VALID_REF}.supabase.co.`;

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

type GoOutput = "env" | "pretty" | "json" | "toml" | "yaml";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: GoOutput;
  readonly cname?: "ok" | "transport-fail" | "no-cname" | "mismatch" | "status-error";
  readonly apiStatus?: number;
  readonly apiNetwork?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-domains-create-int-");

function setup(opts: SetupOpts = {}) {
  const cname = opts.cname ?? "ok";
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    handler: (request) => {
      if (request.url.includes("1.1.1.1")) {
        if (cname === "transport-fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        if (cname === "status-error") {
          return Effect.succeed(legacyJsonResponse(request, 500, { error: "dns down" }));
        }
        const answer =
          cname === "no-cname"
            ? [{ type: 1, data: "1.2.3.4" }]
            : [{ type: 5, data: cname === "mismatch" ? "wrong.example.com." : EXPECTED_CNAME }];
        return Effect.succeed(legacyJsonResponse(request, 200, { Answer: answer }));
      }
      if (opts.apiNetwork === "fail") {
        return Effect.fail(legacyTransportFailure(request));
      }
      return Effect.succeed(legacyJsonResponse(request, opts.apiStatus ?? 201, HOSTNAME_RESPONSE));
    },
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, telemetry, linkedProjectCache };
}

function flags(over: Partial<{ includeRawOutput: boolean }> = {}) {
  return {
    projectRef: Option.none<string>(),
    customHostname: CUSTOM_HOSTNAME,
    includeRawOutput: over.includeRawOutput ?? false,
  };
}

function postedToInitialize(api: { requests: ReadonlyArray<{ url: string }> }): boolean {
  return api.requests.some((r) => r.url.includes("/custom-hostname/initialize"));
}

describe("legacy domains create integration", () => {
  it.live("verifies the CNAME, creates the hostname, and prints status to stderr", () => {
    const { layer, out, api, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsCreate(flags());
      expect(out.stderrText).toContain("Custom hostname configuration complete");
      expect(out.stdoutText).toBe("");
      expect(postedToInitialize(api)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails before any POST when the CNAME lookup transport fails", () => {
    const { layer, api } = setup({ cname: "transport-fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyDomainsCnameError");
        expect(json).toContain("but it failed to resolve");
      }
      expect(postedToInitialize(api)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails before any POST when no CNAME record resolves", () => {
    const { layer, api } = setup({ cname: "no-cname" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to locate appropriate CNAME record");
      }
      expect(postedToInitialize(api)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails before any POST when the CNAME points elsewhere", () => {
    const { layer, api, telemetry } = setup({ cname: "mismatch" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "but it is currently set to 'wrong.example.com.'",
        );
      }
      expect(postedToInitialize(api)).toBe(false);
      // PersistentPostRun still fires even when the CNAME check fails.
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails before any POST when the DNS query returns a non-200 status", () => {
    const { layer, api } = setup({ cname: "status-error" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("but it failed to resolve");
        expect(json).toContain("unexpected DNS query status 500");
      }
      expect(postedToInitialize(api)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented Go JSON to stdout for -o json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsCreate(flags());
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stderrText).toContain("Custom hostname configuration complete");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML to stdout for -o yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyDomainsCreate(flags());
      expect(out.stdoutText).toContain(`custom_hostname: ${CUSTOM_HOSTNAME}`);
      expect(out.stderrText).toContain("Custom hostname configuration complete");
    }).pipe(Effect.provide(layer));
  });

  it.live("forces Go JSON output when --include-raw-output is set", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyDomainsCreate(flags({ includeRawOutput: true }));
      expect(out.stdoutText.startsWith("{")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success object for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyDomainsCreate(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ custom_hostname: CUSTOM_HOSTNAME });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsUnexpectedStatusError when the API returns 503", () => {
    const { layer } = setup({ apiStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("unexpected create hostname status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyDomainsNetworkError when the create request fails", () => {
    const { layer } = setup({ apiNetwork: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to create custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps an API error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", apiStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDomainsCreate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
