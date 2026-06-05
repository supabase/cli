import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

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
import { legacySsoShow } from "./show.handler.ts";

const VALID_PROVIDER_ID = "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8";

const PROVIDER = {
  id: VALID_PROVIDER_ID,
  saml: {
    id: "8682fcf4-4056-455c-bd93-f33295604929",
    entity_id: "https://example.com",
    metadata_url: "https://example.com",
    metadata_xml: '<?xml version="2.0"?>',
  },
  domains: [{ id: "d1", domain: "example.com" }],
  created_at: "2023-03-28T13:50:14.464Z",
  updated_at: "2023-03-28T13:50:14.464Z",
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-show-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  body?: unknown;
  network?: "fail";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const api = mockLegacyPlatformApi({
    network: opts.network,
    response: { status: opts.status ?? 200, body: opts.body ?? PROVIDER },
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

describe("legacy sso show integration", () => {
  it.live("rejects bad UUID with Go-format message", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoShow({
          projectRef: Option.none(),
          providerId: "not-a-uuid",
          metadata: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoInvalidUuidError");
        expect(dump).toContain('identity provider ID \\"not-a-uuid\\" is not a UUID');
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("renders single-provider markdown for valid UUID + 200", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      expect(out.stdoutText).toContain("IDENTITY PROVIDER ID");
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
      expect(out.stdoutText).toContain("https://example.com");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with NotFound on 404", () => {
    const { layer } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoShow({
          projectRef: Option.none(),
          providerId: VALID_PROVIDER_ID,
          metadata: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoShowNotFoundError");
        expect(dump).toContain("An identity provider with ID");
        expect(dump).toContain("could not be found");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with Unexpected on 500", () => {
    const { layer } = setup({ status: 500, body: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoShow({
          projectRef: Option.none(),
          providerId: VALID_PROVIDER_ID,
          metadata: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoShowUnexpectedStatusError");
        expect(dump).toContain("Unexpected error fetching identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with network error on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoShow({
          projectRef: Option.none(),
          providerId: VALID_PROVIDER_ID,
          metadata: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoShowNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env returns env-not-supported error with Go-format message", () => {
    const { layer } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoShow({
          projectRef: Option.none(),
          providerId: VALID_PROVIDER_ID,
          metadata: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoShowEnvNotSupportedError");
        // Go's `utils.ErrEnvNotSupported` verbatim.
        expect(dump).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml encodes response", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml encodes response", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=pretty matches text mode", () => {
    const { layer, out } = setup({ goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("--metadata short-circuits and prints raw XML", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: true,
      });
      expect(out.stdoutText).toBe('<?xml version="2.0"?>\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("--metadata prints empty string + newline when metadata_xml absent", () => {
    const { layer, out } = setup({ body: { id: VALID_PROVIDER_ID } });
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: true,
      });
      expect(out.stdoutText).toBe("\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("does NOT fire cli_upgrade_suggested on 404 (Go's `show` omits it)", () => {
    const { layer, analytics } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacySsoShow({
          projectRef: Option.none(),
          providerId: VALID_PROVIDER_ID,
          metadata: false,
        }),
      );
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("hits GET /v1/projects/{ref}/config/auth/sso/providers/{id}", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoShow({
        projectRef: Option.none(),
        providerId: VALID_PROVIDER_ID,
        metadata: false,
      });
      const req = api.requests.find((r) => r.url.includes(VALID_PROVIDER_ID));
      expect(req?.method).toBe("GET");
      expect(req?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers/${VALID_PROVIDER_ID}`,
      );
    }).pipe(Effect.provide(layer));
  });
});
