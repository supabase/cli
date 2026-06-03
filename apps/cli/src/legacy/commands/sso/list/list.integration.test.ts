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
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { EventUpgradeSuggested } from "../../../../shared/telemetry/event-catalog.ts";
import { legacySsoList } from "./list.handler.ts";

const PROVIDER_ITEM = {
  id: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
  saml: {
    id: "8682fcf4-4056-455c-bd93-f33295604929",
    entity_id: "https://example.com",
    metadata_url: "https://example.com",
    metadata_xml: '<?xml version="2.0"?>',
    attribute_mapping: { keys: { a: { name: "xyz", default: 3 } } },
  },
  domains: [
    {
      id: "9484591c-a203-4500-bea7-d0aaa845e2f5",
      domain: "example.com",
      created_at: "2023-03-28T13:50:14.464Z",
      updated_at: "2023-03-28T13:50:14.464Z",
    },
  ],
  created_at: "2023-03-28T13:50:14.464Z",
  updated_at: "2023-03-28T13:50:14.464Z",
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-list-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  body?: unknown;
  network?: "fail";
  // Configures the upgrade-gate side-call branches:
  //   "gated"     → entitlement says auth.saml_2 has_access=false
  //   "notGated"  → entitlement says auth.saml_2 has_access=true
  //   undefined   → no extra handlers wired; project lookup 404s
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

  const status = opts.status ?? 200;
  const body = opts.body ?? { items: [PROVIDER_ITEM] };
  const gate = opts.upgradeGate;

  const api = mockLegacyPlatformApi({
    network: opts.network,
    handler: (request) => {
      const url = request.url;
      if (url.includes("/config/auth/sso/providers")) {
        return Effect.succeed(jsonResponse(request, status, body));
      }
      if (url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
        if (gate === undefined) {
          return Effect.succeed(jsonResponse(request, 404, {}));
        }
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
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    analytics,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });

  return { layer, out, api, analytics, telemetry, cache };
}

describe("legacy sso list integration", () => {
  it.live("renders an ASCII table in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("TYPE");
      expect(out.stdoutText).toContain("IDENTITY PROVIDER ID");
      expect(out.stdoutText).toContain("0b0d48f6-878b-4190-88d7-2ca33ed800bc");
      expect(out.stdoutText).toContain("example.com");
      expect(out.stdoutText).toContain("2023-03-28 13:50:14");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success payload via --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect((success?.data as { providers: ReadonlyArray<unknown> })?.providers).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event via --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json wraps response in `{providers: …}`", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText).toContain('"providers"');
      expect(out.stdoutText).toContain("0b0d48f6-878b-4190-88d7-2ca33ed800bc");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml emits providers key", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("providers:");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml emits provider data", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env emits a flat PROVIDERS= entry", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("PROVIDERS=");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=pretty falls through to text rendering", () => {
    const { layer, out } = setup({ goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("IDENTITY PROVIDER ID");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over TS --output-format when both set", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(out.stdoutText.startsWith("{")).toBe(false);
      expect(out.stdoutText).toContain("providers:");
    }).pipe(Effect.provide(layer));
  });

  it.live("reports SAML-disabled error on 404", () => {
    const { layer } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoListSamlDisabledError");
        expect(dump).toContain("Looks like SAML 2.0 support is not enabled");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested on 404 when entitlement is gated", () => {
    const { layer, analytics } = setup({ status: 404, body: {}, upgradeGate: "gated" });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoList({ projectRef: Option.none() }));
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("does NOT fire cli_upgrade_suggested when entitlement is not gated", () => {
    const { layer, analytics } = setup({ status: 404, body: {}, upgradeGate: "notGated" });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoList({ projectRef: Option.none() }));
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports unexpected-status error on 500", () => {
    const { layer } = setup({ status: 500, body: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoListUnexpectedStatusError");
        expect(dump).toContain("unexpected error listing identity providers");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reports network error on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoListNetworkError");
        expect(dump).toContain("failed to list sso providers");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over resolver default", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.some(flagRef) });
      const ssoRequest = api.requests.find((r) =>
        r.url.includes(`/v1/projects/${flagRef}/config/auth/sso/providers`),
      );
      expect(ssoRequest).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("hits GET /v1/projects/{ref}/config/auth/sso/providers", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      const ssoRequest = api.requests.find((r) => r.url.endsWith(`/config/auth/sso/providers`));
      expect(ssoRequest?.method).toBe("GET");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even on API failure", () => {
    const { layer, telemetry } = setup({ status: 500, body: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoList({ projectRef: Option.none() }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 500, body: {} });
    return Effect.gen(function* () {
      yield* legacySsoList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
