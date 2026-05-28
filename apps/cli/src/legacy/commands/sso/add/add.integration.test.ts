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
import { legacySsoAdd } from "./add.handler.ts";

const RESPONSE_PROVIDER = {
  id: "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8",
  saml: {
    id: "saml-1",
    entity_id: "https://example.com",
    attribute_mapping: { keys: { a: { name: "xyz", default: 3 } } },
  },
  domains: [{ id: "d1", domain: "example.com" }],
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-add-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  body?: unknown;
  network?: "fail";
  upgradeGate?: "gated" | "notGated";
  // Metadata-URL fetch responses keyed by URL prefix.
  metadataUrlResponse?: { status: number; body: string };
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

function textResponse(
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: string,
) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: { "content-type": "application/xml" },
    }),
  );
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const status = opts.status ?? 201;
  const body = opts.body ?? RESPONSE_PROVIDER;
  const gate = opts.upgradeGate;
  const metadataUrlResponse = opts.metadataUrlResponse;

  const api = mockLegacyPlatformApi({
    network: opts.network,
    handler: (request) => {
      const url = request.url;
      if (url.includes("/config/auth/sso/providers") && request.method === "POST") {
        return Effect.succeed(jsonResponse(request, status, body));
      }
      if (metadataUrlResponse !== undefined && url.startsWith("https://idp.example.com")) {
        return Effect.succeed(
          textResponse(request, metadataUrlResponse.status, metadataUrlResponse.body),
        );
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
  type: "saml" as const,
  domains: [] as ReadonlyArray<string>,
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
};

describe("legacy sso add integration", () => {
  it.live("POSTs to /v1/projects/{ref}/config/auth/sso/providers with type=saml", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect(req).toBeDefined();
      expect(req?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers`);
      expect((req?.body as { type?: string })?.type).toBe("saml");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with mutex-flag error when both metadata flags set", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({
          ...defaultFlags,
          metadataFile: Option.some("/tmp/missing.xml"),
          metadataUrl: Option.some("https://idp.example.com/m"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoMutexFlagError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reads metadata file and sends as metadata_xml", () => {
    const path = join(tempRoot.current, "good.xml");
    writeFileSync(path, '<?xml version="1.0"?><md/>');
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd({ ...defaultFlags, metadataFile: Option.some(path) });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { metadata_xml?: string })?.metadata_xml).toContain("<md/>");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects non-UTF8 metadata file", () => {
    const path = join(tempRoot.current, "bad.xml");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({ ...defaultFlags, metadataFile: Option.some(path) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddMetadataFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("sends metadata_url verbatim when --skip-url-validation", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd({
        ...defaultFlags,
        metadataUrl: Option.some("https://idp.example.com/m"),
        skipUrlValidation: true,
      });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { metadata_url?: string })?.metadata_url).toBe(
        "https://idp.example.com/m",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("validates HTTPS metadata URL when not skipped — success path", () => {
    const { layer, api } = setup({
      metadataUrlResponse: { status: 200, body: '<?xml version="1.0"?><md/>' },
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd({
        ...defaultFlags,
        metadataUrl: Option.some("https://idp.example.com/m"),
        skipUrlValidation: false,
      });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { metadata_url?: string })?.metadata_url).toBe(
        "https://idp.example.com/m",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects non-HTTPS metadata URL with Go-format message", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({
          ...defaultFlags,
          metadataUrl: Option.some("http://idp.example.com/m"),
          skipUrlValidation: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("only HTTPS Metadata URLs are supported");
        expect(dump).toContain("Use --skip-url-validation to suppress this error");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reads attribute mapping JSON and preserves user-defined `default` field", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 3 } } }));
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd({ ...defaultFlags, attributeMappingFile: Option.some(path) });
      const req = api.requests.find((r) => r.method === "POST");
      const mapping = (req?.body as { attribute_mapping?: { keys: { a: { default: number } } } })
        ?.attribute_mapping;
      expect(mapping?.keys.a.default).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("sends domains array verbatim", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd({ ...defaultFlags, domains: ["a.com", "b.com"] });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { domains?: string[] })?.domains).toEqual(["a.com", "b.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders single-provider markdown in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain("IDENTITY PROVIDER ID");
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env returns no output", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports SAML-disabled error on 404", () => {
    const { layer } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddSamlDisabledError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested on 404 when entitlement is gated", () => {
    const { layer, analytics } = setup({ status: 404, body: {}, upgradeGate: "gated" });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports unexpected-status error on 500", () => {
    const { layer } = setup({ status: 500, body: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoAddUnexpectedStatusError");
        expect(dump).toContain("Unexpected error adding identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success and failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500, body: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves attribute_mapping `default` field in POST body", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 42 } } }));
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd({ ...defaultFlags, attributeMappingFile: Option.some(path) });
      const req = api.requests.find((r) => r.method === "POST");
      const mapping = (req?.body as { attribute_mapping?: { keys: { a: { default: number } } } })
        ?.attribute_mapping;
      expect(mapping?.keys.a.default).toBe(42);
    }).pipe(Effect.provide(layer));
  });

  it.live("metadata URL fetch failure surfaces as add metadata file error", () => {
    const { layer } = setup({ metadataUrlResponse: { status: 503, body: "<x/>" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({
          ...defaultFlags,
          metadataUrl: Option.some("https://idp.example.com/m"),
          skipUrlValidation: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoAddMetadataFileError");
        // Per Go's `create.go:47`: error tail is `… Use --skip-url-validation to suppress this error`
        // (no trailing period).
        expect(dump).toContain("Use --skip-url-validation to suppress this error");
      }
    }).pipe(Effect.provide(layer));
  });

  // Non-UTF-8 body coverage lives in `sso.saml.unit.test.ts` — the test runtime
  // here passes the response body through `Response`'s constructor which always
  // emits valid UTF-8 bytes regardless of the input string, so a byte-level
  // invalid sequence cannot be expressed without bypassing the Response API.

  it.live("malformed metadata URL surfaces invalid URI error", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({
          ...defaultFlags,
          metadataUrl: Option.some("::::not a url::::"),
          skipUrlValidation: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddMetadataFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("nameIdFormat is forwarded in the request body when provided", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd({
        ...defaultFlags,
        nameIdFormat: Option.some("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"),
      });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { name_id_format?: string })?.name_id_format).toBe(
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("attribute mapping parse failure surfaces a tagged error", () => {
    const path = join(tempRoot.current, "malformed.json");
    writeFileSync(path, "{not json}");
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({ ...defaultFlags, attributeMappingFile: Option.some(path) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddAttributeMappingFileError");
      }
    }).pipe(Effect.provide(layer));
  });
});
