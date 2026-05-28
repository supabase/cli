import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

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
import { legacySsoInfo } from "./info.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-sso-info-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const api = mockLegacyPlatformApi();
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

const expectedAcsUrl = `https://${LEGACY_VALID_REF}.supabase.co/auth/v1/sso/saml/acs`;
const expectedEntityId = `https://${LEGACY_VALID_REF}.supabase.co/auth/v1/sso/saml/metadata`;
const expectedRelayState = `https://${LEGACY_VALID_REF}.supabase.co`;

describe("legacy sso info integration", () => {
  it.live("renders a 3-row markdown table in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Single sign-on URL (ACS URL)");
      expect(out.stdoutText).toContain("Audience URI (SP Entity ID)");
      expect(out.stdoutText).toContain("Default Relay State");
      expect(out.stdoutText).toContain(expectedAcsUrl);
      expect(out.stdoutText).toContain(expectedEntityId);
      expect(out.stdoutText).toContain(expectedRelayState);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits a structured payload", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({
        acs_url: expectedAcsUrl,
        entity_id: expectedEntityId,
        relay_state: expectedRelayState,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env emits ACS_URL / ENTITY_ID / RELAY_STATE alphabetized", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("ACS_URL=");
      expect(out.stdoutText).toContain("ENTITY_ID=");
      expect(out.stdoutText).toContain("RELAY_STATE=");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json sorts keys alphabetically and includes all three", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('"acs_url"');
      expect(out.stdoutText).toContain('"entity_id"');
      expect(out.stdoutText).toContain('"relay_state"');
      // Keys are alphabetized — acs_url should appear before entity_id.
      const acsIndex = out.stdoutText.indexOf("acs_url");
      const entityIndex = out.stdoutText.indexOf("entity_id");
      expect(acsIndex).toBeLessThan(entityIndex);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml emits the three keys", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("acs_url:");
      expect(out.stdoutText).toContain("entity_id:");
      expect(out.stdoutText).toContain("relay_state:");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml emits the three keys", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("acs_url");
      expect(out.stdoutText).toContain("entity_id");
      expect(out.stdoutText).toContain("relay_state");
    }).pipe(Effect.provide(layer));
  });

  it.live("URLs derive from --project-ref flag value when set", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.some(flagRef) });
      expect(out.stdoutText).toContain(`https://${flagRef}.supabase.co`);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("does NOT make any API call", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoInfo({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
