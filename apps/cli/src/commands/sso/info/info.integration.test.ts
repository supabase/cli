import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";

import { mockAnalytics, mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  VALID_REF,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { ssoInfo } from "./info.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-sso-info-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const api = mockCommandPlatformApi();
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });

  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    analytics,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });

  return { layer, out, api, analytics, telemetry, cache };
}

const expectedAcsUrl = `https://${VALID_REF}.supabase.co/auth/v1/sso/saml/acs`;
const expectedEntityId = `https://${VALID_REF}.supabase.co/auth/v1/sso/saml/metadata`;
const expectedRelayState = `https://${VALID_REF}.supabase.co`;

describe("sso info integration", () => {
  it.effect("renders a 3-row markdown table in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Single sign-on URL (ACS URL)");
      expect(out.stdoutText).toContain("Audience URI (SP Entity ID)");
      expect(out.stdoutText).toContain("Default Relay State");
      expect(out.stdoutText).toContain(expectedAcsUrl);
      expect(out.stdoutText).toContain(expectedEntityId);
      expect(out.stdoutText).toContain(expectedRelayState);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits exactly one space between the ACS URL label and the column separator", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain(`Single sign-on URL (ACS URL) | ${expectedAcsUrl}`);
      expect(out.stdoutText).not.toContain("Single sign-on URL (ACS URL)  |");
    }).pipe(Effect.provide(layer));
  });

  it.effect("TS --output-format=json emits a structured payload", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({
        acs_url: expectedAcsUrl,
        entity_id: expectedEntityId,
        relay_state: expectedRelayState,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=env emits ACS_URL / ENTITY_ID / RELAY_STATE alphabetized", () => {
    const { layer, out } = setup({ outputFlag: "env" });
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("ACS_URL=");
      expect(out.stdoutText).toContain("ENTITY_ID=");
      expect(out.stdoutText).toContain("RELAY_STATE=");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=json sorts keys alphabetically and includes all three", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('"acs_url"');
      expect(out.stdoutText).toContain('"entity_id"');
      expect(out.stdoutText).toContain('"relay_state"');
      const acsIndex = out.stdoutText.indexOf("acs_url");
      const entityIndex = out.stdoutText.indexOf("entity_id");
      expect(acsIndex).toBeLessThan(entityIndex);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=yaml emits the three keys", () => {
    const { layer, out } = setup({ outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("acs_url:");
      expect(out.stdoutText).toContain("entity_id:");
      expect(out.stdoutText).toContain("relay_state:");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=toml emits the three keys", () => {
    const { layer, out } = setup({ outputFlag: "toml" });
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("acs_url");
      expect(out.stdoutText).toContain("entity_id");
      expect(out.stdoutText).toContain("relay_state");
    }).pipe(Effect.provide(layer));
  });

  it.effect("URLs derive from --project-ref flag value when set", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.some(flagRef) });
      expect(out.stdoutText).toContain(`https://${flagRef}.supabase.co`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry + linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("makes no Management API call of its own", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* ssoInfo({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects and fills the real cache, with no call of its own", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url === "https://api.supabase.com/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        return Effect.succeed(jsonResponse(request, 404, {}));
      },
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: true }),
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* ssoInfo({ projectRef: Option.none() });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toContain(expectedAcsUrl);
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({ command: "sso info", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });
});
