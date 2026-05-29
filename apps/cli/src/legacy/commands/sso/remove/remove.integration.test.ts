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
import { legacySsoRemove } from "./remove.handler.ts";

const VALID_PROVIDER_ID = "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8";

const PROVIDER = {
  id: VALID_PROVIDER_ID,
  saml: { id: "x", entity_id: "https://example.com" },
  domains: [{ id: "d1", domain: "example.com" }],
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-remove-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  body?: unknown;
  network?: "fail";
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
  const body = opts.body ?? PROVIDER;
  const gate = opts.upgradeGate;

  const api = mockLegacyPlatformApi({
    network: opts.network,
    handler: (request) => {
      const url = request.url;
      if (url.includes("/config/auth/sso/providers/") && request.method === "DELETE") {
        return Effect.succeed(jsonResponse(request, status, body));
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
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    analytics,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });

  return { layer, out, api, analytics, telemetry, cache };
}

describe("legacy sso remove integration", () => {
  it.live("rejects bad UUID", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoRemove({ projectRef: Option.none(), providerId: "not-a-uuid" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoInvalidUuidError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("DELETEs the correct path and renders provider in text mode", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID });
      const req = api.requests.find((r) => r.method === "DELETE");
      expect(req?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers/${VALID_PROVIDER_ID}`,
      );
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with NotFound on 404", () => {
    const { layer } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoRemoveNotFoundError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with Unexpected on 500", () => {
    const { layer } = setup({ status: 500, body: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoRemoveUnexpectedStatusError");
        expect(dump).toContain("Unexpected error removing identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested when gated on 4xx", () => {
    const { layer, analytics } = setup({ status: 404, body: {}, upgradeGate: "gated" });
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID }),
      );
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env emits nothing", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID });
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID });
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID });
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with network error on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoRemove({ projectRef: Option.none(), providerId: VALID_PROVIDER_ID }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoRemoveNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });
});
