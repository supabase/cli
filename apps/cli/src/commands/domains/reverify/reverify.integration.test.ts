import { type V1GetHostnameConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockAnalytics, mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  unverifiedTargetBanner,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { domainsReverify } from "./reverify.handler.ts";

const HOSTNAME_RESPONSE: typeof V1GetHostnameConfigOutput.Type = {
  status: "2_initiated",
  custom_hostname: "shop.acme.dev",
  data: {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: "id-1",
      hostname: "shop.acme.dev",
      ssl: { status: "initializing", validation_records: [] },
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
  readonly status?: number;
  readonly network?: "fail";
  readonly response?: unknown;
}

const tempRoot = useTempWorkdir("supabase-domains-reverify-int-");

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? HOSTNAME_RESPONSE },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
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

const baseFlags = { projectRef: Option.none<string>(), includeRawOutput: Option.none<boolean>() };

describe("domains reverify integration", () => {
  it.effect("suggests upgrade from entitlement_required envelope on 400", () => {
    const { layer, out, analytics, api } = setup({
      status: 400,
      response: {
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
      const exit = yield* Effect.exit(domainsReverify(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(1);
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

  it.effect("prints the initializing status to stderr in text mode", () => {
    const { layer, out, api, telemetry, linkedProjectCache } = setup();
    return Effect.gen(function* () {
      yield* domainsReverify(baseFlags);
      expect(out.stderrText).toContain("being initialized");
      expect(out.stdoutText).toBe("");
      expect(api.requests[0]?.url).toContain("/custom-hostname/reverify");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
      assertPermissionDrift({ command: "domains reverify", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured success object for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* domainsReverify(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ custom_hostname: "shop.acme.dev" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits indented JSON to stdout with no status on stderr for -o json", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* domainsReverify(baseFlags);
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stderrText).toBe(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DomainsUnexpectedStatusError on HTTP 503", () => {
    const { layer, telemetry } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsReverify(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("unexpected re-verify hostname status 503");
      }
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with DomainsNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsReverify(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("failed to re-verify custom hostname");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps an HTTP error without a spinner in json mode", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(domainsReverify(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "picks the project, reverifies the hostname and fills the linked-project cache through the real layers",
    () => {
      const out = mockOutput({ promptSelectResponses: [VALID_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          const route = `${request.method} ${request.url}`;
          if (route === "GET https://api.supabase.com/v1/projects") {
            return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
          }
          if (route === `GET https://api.supabase.com/v1/projects/${VALID_REF}`) {
            return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
          }
          if (
            route ===
            `POST https://api.supabase.com/v1/projects/${VALID_REF}/custom-hostname/reverify`
          ) {
            return Effect.succeed(jsonResponse(request, 201, HOSTNAME_RESPONSE));
          }
          return Effect.succeed(jsonResponse(request, 404, { message: "unexpected request" }));
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
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
        expect(yield* fs.exists(cachePath)).toBe(false);
        yield* domainsReverify(baseFlags);
        expect(out.stderrText).toContain("being initialized");
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "GET https://api.supabase.com/v1/projects",
          `POST https://api.supabase.com/v1/projects/${VALID_REF}/custom-hostname/reverify`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "domains reverify", requests: api.requests, exact: true });
      }).pipe(Effect.provide(layer));
    },
  );
});
