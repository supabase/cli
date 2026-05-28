import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { EventUpgradeSuggested } from "../../../../shared/telemetry/event-catalog.ts";
import { legacySsoUpdate } from "./update.handler.ts";

const VALID_PROVIDER_ID = "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8";

const EXISTING_PROVIDER = {
  id: VALID_PROVIDER_ID,
  saml: { id: "saml-1", entity_id: "https://example.com" },
  domains: [
    { id: "d1", domain: "old1.com" },
    { id: "d2", domain: "old2.com" },
  ],
};

const RESPONSE_PROVIDER = {
  id: VALID_PROVIDER_ID,
  saml: { id: "saml-1", entity_id: "https://example.com" },
  domains: [{ id: "d3", domain: "new.com" }],
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-update-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  getStatus?: number;
  getBody?: unknown;
  putStatus?: number;
  putBody?: unknown;
  upgradeGate?: "gated" | "notGated";
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

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const gate = opts.upgradeGate;
  const getStatus = opts.getStatus ?? 200;
  const getBody = opts.getBody ?? EXISTING_PROVIDER;
  const putStatus = opts.putStatus ?? 200;
  const putBody = opts.putBody ?? RESPONSE_PROVIDER;

  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/config/auth/sso/providers/")) {
        if (request.method === "GET")
          return Effect.succeed(jsonResponse(request, getStatus, getBody));
        if (request.method === "PUT")
          return Effect.succeed(jsonResponse(request, putStatus, putBody));
      }
      if (url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
        if (gate === undefined) return Effect.succeed(jsonResponse(request, 404, {}));
        return Effect.succeed(
          jsonResponse(request, 200, {
            id: LEGACY_VALID_REF,
            ref: LEGACY_VALID_REF,
            organization_id: "org-id",
            organization_slug: "acme",
            name: "Test",
            region: "us-east-1",
            created_at: "2023-01-01T00:00:00Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: "db.example.com",
              version: "15",
              postgres_engine: "15",
              release_channel: "ga",
            },
          }),
        );
      }
      if (url.includes("/v1/organizations/acme/entitlements")) {
        return Effect.succeed(
          jsonResponse(request, 200, {
            entitlements: [
              {
                feature: { key: "auth.saml_2", type: "boolean" },
                hasAccess: gate === "notGated",
                type: "boolean",
                config: { enabled: false },
              },
            ],
          }),
        );
      }
      return Effect.succeed(jsonResponse(request, 404, {}));
    },
  });

  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api: { layer: api.layer, httpClientLayer: api.httpClientLayer },
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    analytics,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });

  return { layer, out, api, analytics, telemetry, cache };
}

const defaultFlags = {
  projectRef: Option.none<string>(),
  domains: [] as ReadonlyArray<string>,
  addDomains: [] as ReadonlyArray<string>,
  removeDomains: [] as ReadonlyArray<string>,
  metadataFile: Option.none<string>(),
  metadataUrl: Option.none<string>(),
  skipUrlValidation: false,
  attributeMappingFile: Option.none<string>(),
  nameIdFormat: Option.none<
    | "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    | "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
    | "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
    | "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
  >(),
  providerId: VALID_PROVIDER_ID,
};

describe("legacy sso update integration", () => {
  it.live("rejects bad UUID", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, providerId: "not-a-uuid" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoInvalidUuidError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("always GETs before PUTting", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      const methods = api.requests.map((r) => r.method);
      expect(methods.indexOf("GET")).toBeLessThan(methods.indexOf("PUT"));
    }).pipe(Effect.provide(layer));
  });

  it.live("GET 404 → NotFound error", () => {
    const { layer } = setup({ getStatus: 404, getBody: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoUpdateNotFoundError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("GET 500 → unexpected-status error", () => {
    const { layer } = setup({ getStatus: 500, getBody: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateUnexpectedStatusError");
        expect(dump).toContain("unexpected error fetching identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("mutex check: --domains + --add-domains fails", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, domains: ["a.com"], addDomains: ["b.com"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoMutexFlagError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("mutex check: --domains + --remove-domains fails", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, domains: ["a.com"], removeDomains: ["b.com"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("mutex check: --metadata-file + --metadata-url fails", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          metadataFile: Option.some("/tmp/x.xml"),
          metadataUrl: Option.some("https://idp.example.com/m"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--domains replaces domains verbatim", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, domains: ["new.com"] });
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { domains?: string[] })?.domains).toEqual(["new.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("--add-domains merges with existing GET domains", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, addDomains: ["new.com"] });
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      // Go map iteration is unordered — sort before asserting.
      expect([...domains].sort()).toEqual(["new.com", "old1.com", "old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("--remove-domains strips from existing GET domains", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, removeDomains: ["old1.com"] });
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      expect([...domains].sort()).toEqual(["old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("no domain flag set → body.domains omitted", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { domains?: string[] })?.domains).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("reads metadata file and sends as metadata_xml on PUT", () => {
    const path = join(tempRoot.current, "good.xml");
    writeFileSync(path, '<?xml version="1.0"?><md/>');
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, metadataFile: Option.some(path) });
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { metadata_xml?: string })?.metadata_xml).toContain("<md/>");
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves attribute_mapping `default` field in PUT body", () => {
    const path = join(tempRoot.current, "map.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 3 } } }));
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, attributeMappingFile: Option.some(path) });
      const putReq = api.requests.find((r) => r.method === "PUT");
      const mapping = (putReq?.body as { attribute_mapping?: { keys: { a: { default: number } } } })
        ?.attribute_mapping;
      expect(mapping?.keys.a.default).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("PUT 200 → renders single-provider markdown in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("PUT 4xx + gated entitlement → unexpected error + cli_upgrade_suggested", () => {
    // suggestUpgradeOnError fires only on 4xx (matches Go's `plan_gate.go:29`).
    const { layer, analytics } = setup({
      putStatus: 403,
      putBody: { error: "forbidden" },
      upgradeGate: "gated",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoUpdateUnexpectedStatusError");
      }
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env emits nothing", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even on GET failure", () => {
    const { layer, telemetry } = setup({ getStatus: 500, getBody: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("nameIdFormat is forwarded in PUT body when provided", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({
        ...defaultFlags,
        nameIdFormat: Option.some("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"),
      });
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { name_id_format?: string })?.name_id_format).toBe(
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("malformed metadata URL surfaces as update metadata file error", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          metadataUrl: Option.some("::::not a url::::"),
          skipUrlValidation: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateMetadataFileError");
        // Per Go's `update.go:69`: error tail is `… Use --skip-url-validation to suppress this error.`
        // (trailing period).
        expect(dump).toContain("Use --skip-url-validation to suppress this error.");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("malformed attribute-mapping JSON surfaces a tagged error", () => {
    const path = join(tempRoot.current, "malformed.json");
    writeFileSync(path, "{not json}");
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, attributeMappingFile: Option.some(path) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoUpdateAttributeMappingFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--add-domains + --remove-domains combined apply remove then add", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate({
        ...defaultFlags,
        addDomains: ["new.com"],
        removeDomains: ["old1.com"],
      });
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      // Go uses map iteration → unordered; sort before asserting.
      expect([...domains].sort()).toEqual(["new.com", "old2.com"]);
    }).pipe(Effect.provide(layer));
  });
});
