import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { type ApiClient, makeApiClient, type SupabaseApiConfigError } from "@supabase/api/effect";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientRequestModule from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as UrlParams from "effect/unstable/http/UrlParams";
import { afterEach, beforeEach } from "vitest";

import { LegacyCredentials } from "../../src/legacy/auth/legacy-credentials.service.ts";
import { LegacyPlatformApi } from "../../src/legacy/auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../src/legacy/config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../src/legacy/config/legacy-project-ref.layer.ts";
import { LegacyLinkedProjectCache } from "../../src/legacy/telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../src/legacy/telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../src/shared/legacy/global-flags.ts";
import type { Output } from "../../src/shared/output/output.service.ts";
import type { ProcessControl } from "../../src/shared/runtime/process-control.service.ts";
import type { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";
import type { Tty } from "../../src/shared/runtime/tty.service.ts";
import { Analytics } from "../../src/shared/telemetry/analytics.service.ts";
import { mockAnalytics, mockProcessControl, mockRuntimeInfo, mockTty } from "./mocks.ts";

// ---------------------------------------------------------------------------
// Constants — Go-parity test fixtures used across every native-port integration
// test. Centralized so a change to the project-ref schema (e.g. updated length)
// only needs to update one constant.
// ---------------------------------------------------------------------------

export const LEGACY_VALID_REF = "abcdefghijklmnopqrst";
export const LEGACY_VALID_TOKEN = "sbp_" + "a".repeat(40);
export const LEGACY_DEFAULT_API_URL = "https://api.supabase.com";
export const LEGACY_DEFAULT_USER_AGENT = "SupabaseCLI/0.0.0-dev";

// ---------------------------------------------------------------------------
// No-op layers — drop-in for tests that don't assert on telemetry / cache state.
// ---------------------------------------------------------------------------

export const mockLegacyLinkedProjectCacheLayer = Layer.succeed(LegacyLinkedProjectCache, {
  cache: () => Effect.void,
});

export const mockLegacyTelemetryStateLayer = Layer.succeed(LegacyTelemetryState, {
  flush: Effect.void,
});

// Default LegacyCredentials mock. `mockLegacyCliConfig` defaults to an env-set
// access token, so handlers never hit the credentials fallback in tests — but
// the service still needs to be in the layer to satisfy the required-services
// signature. Save/delete die to surface accidental writes inside read-only
// handlers.
export const mockLegacyCredentialsLayer = Layer.succeed(LegacyCredentials, {
  getAccessToken: Effect.sync(() => Option.none()),
  saveAccessToken: () => Effect.die("unexpected legacy credentials write in test"),
  deleteAccessToken: Effect.die("unexpected legacy credentials delete in test"),
});

// ---------------------------------------------------------------------------
// State-tracking factories — for PersistentPostRun-parity assertions
// (telemetry must flush, linked-project cache fires after ref resolution).
// Shape matches the inline helpers the 9 native-port tests used pre-extraction.
// ---------------------------------------------------------------------------

export function mockLegacyTelemetryStateTracked(): {
  readonly layer: Layer.Layer<LegacyTelemetryState>;
  readonly flushed: boolean;
} {
  let flushed = false;
  const layer = Layer.succeed(LegacyTelemetryState, {
    get flush() {
      return Effect.sync(() => {
        flushed = true;
      });
    },
  });
  return {
    layer,
    get flushed() {
      return flushed;
    },
  };
}

export function mockLegacyLinkedProjectCacheTracked(): {
  readonly layer: Layer.Layer<LegacyLinkedProjectCache>;
  readonly cached: boolean;
} {
  let cached = false;
  const layer = Layer.succeed(LegacyLinkedProjectCache, {
    cache: (_ref: string) =>
      Effect.sync(() => {
        cached = true;
      }),
  });
  return {
    layer,
    get cached() {
      return cached;
    },
  };
}

// ---------------------------------------------------------------------------
// CLI config factory — defaults match the common case (linked project, valid
// access token, supabase.com API URL). Tests override individual fields when
// they need to exercise alternative resolution paths.
// ---------------------------------------------------------------------------

export function mockLegacyCliConfig(opts: {
  readonly workdir: string;
  readonly profile?: string;
  readonly apiUrl?: string;
  readonly projectHost?: string;
  readonly accessToken?: Option.Option<Redacted.Redacted<string>>;
  readonly projectId?: Option.Option<string>;
  readonly userAgent?: string;
}): Layer.Layer<LegacyCliConfig> {
  return Layer.succeed(LegacyCliConfig, {
    profile: opts.profile ?? "supabase",
    apiUrl: opts.apiUrl ?? LEGACY_DEFAULT_API_URL,
    projectHost: opts.projectHost ?? "supabase.co",
    accessToken: opts.accessToken ?? Option.some(Redacted.make(LEGACY_VALID_TOKEN)),
    projectId: opts.projectId ?? Option.some(LEGACY_VALID_REF),
    workdir: opts.workdir,
    userAgent: opts.userAgent ?? LEGACY_DEFAULT_USER_AGENT,
  });
}

// ---------------------------------------------------------------------------
// HTTP transport primitives — exported as low-level building blocks for tests
// that need a custom `handler` in `mockLegacyPlatformApi`.
// ---------------------------------------------------------------------------

export function legacyJsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

export function legacyTransportFailure(
  request: HttpClientRequest.HttpClientRequest,
  description = "ECONNREFUSED",
): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description }),
  });
}

/**
 * Builds a real `HttpClientError` with a `StatusCodeError` reason for the
 * given status code. Useful for the direct-service mock when the handler under
 * test branches on `HttpClientError.isHttpClientError(cause)` + `cause.response.status`.
 */
export function legacyStatusCodeFailure(status: number): HttpClientError.HttpClientError {
  const request = HttpClientRequestModule.get("https://api.supabase.com/mock");
  const response = HttpClientResponse.fromWeb(
    request,
    new Response("", { status, headers: { "content-type": "application/json" } }),
  );
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response }),
  });
}

function legacyHttpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

// ---------------------------------------------------------------------------
// Platform API factory — hybrid surface.
//
// Precedence (high → low): `network: "fail"` > `handler` > `byMethod` > `response`.
// `body` is JSON-decoded when the Uint8Array body parses; otherwise the raw
// decoded string is stored. Falsy bodies (no request body) record `undefined`.
// ---------------------------------------------------------------------------

export type LegacyHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface LegacyRecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  // Captured separately because Effect's HttpClient keeps `urlParams` on the
  // request struct and only merges it into the final URL inside the real
  // transport layer (`HttpClient.ts:747`). Tests that need to assert on
  // GET-style query parameters (e.g. `/v1/snippets?project_ref=…`) read this
  // serialized form instead of `url`.
  readonly urlParams: string;
  // Convenience: `url + "?" + urlParams` (or just `url` when there are none).
  // Use this when an assertion wants to check the path and query in one
  // string, mirroring what `curl -v` would print as the request line.
  readonly urlWithParams: string;
}

export interface LegacyApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export type LegacyApiHandler = (
  request: HttpClientRequest.HttpClientRequest,
  recorded: LegacyRecordedRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

export interface MockLegacyPlatformApiOpts {
  readonly response?: LegacyApiResponse;
  readonly byMethod?: Partial<Record<LegacyHttpMethod, LegacyApiResponse>>;
  readonly handler?: LegacyApiHandler;
  readonly network?: "fail";
  readonly apiUrl?: string;
  readonly userAgent?: string;
  readonly accessToken?: string;
}

export interface MockLegacyPlatformApiResult {
  // `SupabaseApiConfigError` is the build-time validation error from `makeApiClient`;
  // it never actually triggers with the defaults this factory supplies, but the
  // type leaks through the Layer.effect signature.
  readonly layer: Layer.Layer<LegacyPlatformApi, SupabaseApiConfigError>;
  // Same recording handler exposed as a standalone HttpClient layer so legacy
  // handlers that bypass the typed client (e.g. sso add/update preserving
  // arbitrary attribute_mapping keys) can hit `httpClient.execute(req)` while
  // still recording requests into the shared `requests` array.
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: ReadonlyArray<LegacyRecordedRequest>;
}

export function mockLegacyPlatformApi(
  opts: MockLegacyPlatformApiOpts = {},
): MockLegacyPlatformApiResult {
  const requests: LegacyRecordedRequest[] = [];

  const handler = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      let body: unknown = undefined;
      if (request.body._tag === "Uint8Array") {
        const decoded = new TextDecoder().decode(request.body.body);
        try {
          body = JSON.parse(decoded);
        } catch {
          body = decoded;
        }
      }
      const params = UrlParams.toString(request.urlParams);
      const recorded: LegacyRecordedRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
        urlParams: params,
        urlWithParams: params === "" ? request.url : `${request.url}?${params}`,
      };
      requests.push(recorded);

      if (opts.network === "fail") {
        return yield* Effect.fail(legacyTransportFailure(request));
      }
      if (opts.handler !== undefined) {
        return yield* opts.handler(request, recorded);
      }
      const methodResponse = opts.byMethod?.[request.method as LegacyHttpMethod];
      if (methodResponse !== undefined) {
        return legacyJsonResponse(request, methodResponse.status, methodResponse.body);
      }
      if (opts.response !== undefined) {
        return legacyJsonResponse(request, opts.response.status, opts.response.body);
      }
      // No response configured — emit a 200 with an empty body. Most tests
      // configure at least one response shape; this default keeps unconfigured
      // calls from hanging.
      return legacyJsonResponse(request, 200, null);
    });

  const httpClientLayer = legacyHttpClientLayer(handler);

  const layer = Layer.effect(
    LegacyPlatformApi,
    makeApiClient({
      baseUrl: opts.apiUrl ?? LEGACY_DEFAULT_API_URL,
      accessToken: opts.accessToken ?? LEGACY_VALID_TOKEN,
      userAgent: opts.userAgent ?? LEGACY_DEFAULT_USER_AGENT,
    }),
  ).pipe(Layer.provide(httpClientLayer));

  return { layer, httpClientLayer, requests };
}

// ---------------------------------------------------------------------------
// Direct-service mock for LegacyPlatformApi.
//
// Bypasses the real API client's input/output schema validation by providing
// `LegacyPlatformApi` via `Layer.succeed` directly. Use this when:
//
//   - the API schema is too strict for the test scenario (e.g. the
//     `branch_id_or_ref` oneOf union rejects 20-letter project refs because
//     the UUID branch has no actual UUID pattern check), AND
//   - the handler logic under test does not depend on the byte-exact wire
//     format of requests/responses.
//
// The recorded `requests` array tracks `{ method, input }` for every call.
// Methods not present in `v1Stubs` die at call time so missing wiring shows
// up loud and clear instead of silently returning undefined.
// ---------------------------------------------------------------------------

type V1Stubs = Partial<{
  readonly [K in keyof ApiClient["v1"]]: (
    input: Parameters<ApiClient["v1"][K]>[0],
  ) => Effect.Effect<unknown, unknown>;
}>;

export interface MockLegacyPlatformApiServiceOpts {
  readonly v1?: V1Stubs;
}

export interface MockLegacyPlatformApiServiceResult {
  readonly layer: Layer.Layer<LegacyPlatformApi>;
  readonly requests: ReadonlyArray<{ readonly method: string; readonly input: unknown }>;
}

export function mockLegacyPlatformApiService(
  opts: MockLegacyPlatformApiServiceOpts = {},
): MockLegacyPlatformApiServiceResult {
  const requests: Array<{ method: string; input: unknown }> = [];
  const stubs = opts.v1 ?? {};

  const v1Proxy = new Proxy({} as ApiClient["v1"], {
    get(_target, prop: string) {
      return (input: unknown) =>
        Effect.gen(function* () {
          requests.push({ method: prop, input });
          const stub = (stubs as Record<string, unknown>)[prop] as
            | ((i: unknown) => Effect.Effect<unknown, unknown>)
            | undefined;
          if (stub === undefined) {
            return yield* Effect.die(`Unmocked LegacyPlatformApi.v1.${prop}`);
          }
          return yield* stub(input);
        });
    },
  });

  const layer = Layer.succeed(LegacyPlatformApi, { v1: v1Proxy } as ApiClient);

  return { layer, requests };
}

// ---------------------------------------------------------------------------
// Temp workdir lifecycle — calls vitest beforeEach/afterEach internally, so
// the helper must be invoked at module scope (or inside the surrounding
// `describe`). Accessing `.current` outside a test throws.
// ---------------------------------------------------------------------------

export function useLegacyTempWorkdir(prefix = "supabase-legacy-test-"): {
  readonly current: string;
} {
  let root: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });
  return {
    get current() {
      if (root === undefined) {
        throw new Error(
          "useLegacyTempWorkdir().current accessed outside an active test — call it inside it.live(...) or it(...)",
        );
      }
      return root;
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime composition — bundles the entire Layer.mergeAll(...) graph that
// every native-port integration test re-builds, including the easy-to-mis-wire
// `legacyProjectRefLayer.pipe(Layer.provide(...))` subgraph
// (legacy CLAUDE.md item 5: "Layer.provide does not share to siblings inside
// Layer.mergeAll" — centralising the subgraph here removes a recurring footgun).
// ---------------------------------------------------------------------------

type GoOutputValue = "env" | "pretty" | "json" | "toml" | "yaml";

// ---------------------------------------------------------------------------
// Analytics mock lives in `./mocks.ts` (`mockAnalytics`) — same shape we used
// to ship in a `mockLegacyAnalytics` helper here. Use `mockAnalytics()` from
// the shared mocks module directly.

export interface BuildLegacyTestRuntimeOpts {
  readonly out: { readonly layer: Layer.Layer<Output> };
  // `Layer.Layer<LegacyPlatformApi, SupabaseApiConfigError>` from
  // `mockLegacyPlatformApi`; the error channel never fires in practice but
  // its presence here keeps callers from needing an `as` cast.
  readonly api: {
    readonly layer: Layer.Layer<LegacyPlatformApi, SupabaseApiConfigError>;
    readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  };
  readonly cliConfig: Layer.Layer<LegacyCliConfig>;
  readonly tty?: Layer.Layer<Tty>;
  readonly processControl?: { readonly layer: Layer.Layer<ProcessControl> };
  readonly runtimeInfo?: Layer.Layer<RuntimeInfo>;
  readonly telemetry?: Layer.Layer<LegacyTelemetryState>;
  readonly linkedProjectCache?: Layer.Layer<LegacyLinkedProjectCache>;
  readonly analytics?: { readonly layer: Layer.Layer<Analytics> };
  readonly goOutput?: Option.Option<GoOutputValue>;
}

export function buildLegacyTestRuntime(opts: BuildLegacyTestRuntimeOpts) {
  const tty = opts.tty ?? mockTty({ stdinIsTty: false, stdoutIsTty: false });
  const processControl = (opts.processControl ?? mockProcessControl()).layer;
  const runtimeInfo = opts.runtimeInfo ?? mockRuntimeInfo();
  const telemetry = opts.telemetry ?? mockLegacyTelemetryStateLayer;
  const linkedProjectCache = opts.linkedProjectCache ?? mockLegacyLinkedProjectCacheLayer;
  const analytics = (opts.analytics ?? mockAnalytics()).layer;
  const goOutput = opts.goOutput ?? Option.none<GoOutputValue>();
  const httpClient = opts.api.httpClientLayer;

  // When the caller doesn't expose an HttpClient layer, use a stub that fails
  // loudly if any code path tries to consume it. Always wiring HttpClient at
  // the top level keeps the layer's exported services stable for type-checking
  // (otherwise the conditional branch confuses TS-side inference).
  const noopHttpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() =>
      Effect.die(
        "unexpected HttpClient.execute() in legacy test runtime — pass api.httpClientLayer",
      ),
    ),
  );

  return Layer.mergeAll(
    opts.out.layer,
    opts.api.layer,
    opts.cliConfig,
    tty,
    processControl,
    runtimeInfo,
    legacyProjectRefLayer.pipe(
      Layer.provide(opts.api.layer),
      Layer.provide(opts.cliConfig),
      Layer.provide(tty),
      Layer.provide(opts.out.layer),
      Layer.provide(BunServices.layer),
    ),
    BunServices.layer,
    Layer.succeed(LegacyOutputFlag, goOutput),
    linkedProjectCache,
    telemetry,
    analytics,
    mockLegacyCredentialsLayer,
    httpClient ?? noopHttpClient,
  );
}
