import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { type ApiClient, makeApiClient, type SupabaseApiConfigError } from "@supabase/api/effect";
import { Effect, FileSystem, Layer, Option, Redacted, Sink, Stream } from "effect";
import { PlatformError, SystemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientRequestModule from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as UrlParams from "effect/unstable/http/UrlParams";
import { afterEach, beforeEach } from "vitest";

import { LegacyCredentials } from "../../src/legacy/auth/legacy-credentials.service.ts";
import {
  LegacyCredentialDeleteError,
  LegacyDeleteTokenError,
  LegacyInvalidAccessTokenError,
  LegacyNotLoggedInError,
} from "../../src/legacy/auth/legacy-errors.ts";
import { LegacyPlatformApiFactory } from "../../src/legacy/auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../../src/legacy/auth/legacy-platform-api.service.ts";
import {
  LegacyLoginApi,
  type LegacyLoginSessionResponse,
} from "../../src/legacy/commands/login/login-api.service.ts";
import { LegacyLoginCrypto } from "../../src/legacy/commands/login/login-crypto.service.ts";
import {
  LegacyLoginCryptoError,
  LegacyLoginDecryptError,
  LegacyLoginVerificationError,
} from "../../src/legacy/commands/login/login.errors.ts";
import { LegacyCliConfig } from "../../src/legacy/config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../src/legacy/config/legacy-project-ref.layer.ts";
import { LegacyLinkedProjectCache } from "../../src/legacy/telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../src/legacy/telemetry/legacy-telemetry-state.service.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import type { Stdin } from "../../src/shared/runtime/stdin.service.ts";
import { LegacyOutputFlag } from "../../src/shared/legacy/global-flags.ts";
import type { Output } from "../../src/shared/output/output.service.ts";
import type { ProcessControl } from "../../src/shared/runtime/process-control.service.ts";
import type { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";
import type { Tty } from "../../src/shared/runtime/tty.service.ts";
import { Analytics } from "../../src/shared/telemetry/analytics.service.ts";
import {
  mockAnalytics,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
  processEnvLayer,
} from "./mocks.ts";

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
  stitchLogin: () => Effect.void,
  clearDistinctId: Effect.void,
  resetIdentity: Effect.void,
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
  deleteAllProjectCredentials: Effect.die("unexpected legacy project-credential sweep in test"),
  deleteProjectCredential: () => Effect.die("unexpected legacy project-credential delete in test"),
});

/**
 * Tracked `LegacyCredentials` mock for `unlink` / `login` / `logout` tests.
 *
 * - `deleteProjectCredential` (unlink): records refs in `deletedRefs`; `deleteFails`
 *   makes it raise `LegacyCredentialDeleteError`.
 * - `saveAccessToken` (login): records the saved token in `savedToken`; `saveFails`
 *   raises `LegacyInvalidAccessTokenError` (the token-path "cannot save" branch).
 * - `deleteAccessToken` (logout): `deleteOutcome` selects success (`"ok"`),
 *   `LegacyNotLoggedInError` (`"notLoggedIn"`), or `LegacyDeleteTokenError`
 *   (`"deleteError"`).
 * - `deleteAllProjectCredentials` (logout): flips `deletedAll`.
 */
export function mockLegacyCredentialsTracked(
  opts: {
    readonly deleteFails?: boolean;
    readonly saveFails?: boolean;
    readonly deleteOutcome?: "ok" | "notLoggedIn" | "deleteError";
  } = {},
): {
  readonly layer: Layer.Layer<LegacyCredentials>;
  readonly deletedRefs: ReadonlyArray<string>;
  readonly savedToken: string | undefined;
  readonly deletedAll: boolean;
} {
  const deletedRefs: string[] = [];
  let savedToken: string | undefined;
  let deletedAll = false;

  const deleteAccessToken =
    opts.deleteOutcome === "notLoggedIn"
      ? Effect.fail(
          new LegacyNotLoggedInError({ message: "You were not logged in, nothing to do." }),
        )
      : opts.deleteOutcome === "deleteError"
        ? Effect.fail(
            new LegacyDeleteTokenError({
              message: "failed to remove access token file: permission denied",
            }),
          )
        : Effect.void;

  const layer = Layer.succeed(LegacyCredentials, {
    getAccessToken: Effect.sync(() => Option.none()),
    saveAccessToken: (token: string) =>
      opts.saveFails === true
        ? Effect.fail(
            new LegacyInvalidAccessTokenError({
              message: "Invalid access token format. Must be like `sbp_0102...1920`.",
            }),
          )
        : Effect.sync(() => {
            savedToken = token;
          }),
    deleteAccessToken,
    deleteAllProjectCredentials: Effect.sync(() => {
      deletedAll = true;
    }),
    deleteProjectCredential: (projectRef: string) =>
      Effect.gen(function* () {
        deletedRefs.push(projectRef);
        if (opts.deleteFails === true) {
          return yield* Effect.fail(
            new LegacyCredentialDeleteError({
              message: "failed to delete project credential: permission denied",
            }),
          );
        }
        return true;
      }),
  });
  return {
    layer,
    get deletedRefs() {
      return deletedRefs;
    },
    get savedToken() {
      return savedToken;
    },
    get deletedAll() {
      return deletedAll;
    },
  };
}

// ---------------------------------------------------------------------------
// Login crypto / API mocks. The crypto mock returns a dummy ECDH handle (the
// browser-flow integration tests never reach a real decrypt — the API mock
// supplies the ciphertext and the crypto mock returns the decrypted token).
// ---------------------------------------------------------------------------

export function mockLegacyLoginCrypto(
  opts: {
    readonly publicKeyHex?: string;
    readonly sessionId?: string;
    readonly tokenName?: string;
    readonly decryptedToken?: string;
    readonly decryptFails?: boolean;
    readonly keygenFails?: boolean;
  } = {},
): { readonly layer: Layer.Layer<LegacyLoginCrypto> } {
  const layer = Layer.succeed(LegacyLoginCrypto, {
    generateKeyPair: opts.keygenFails
      ? Effect.fail(new LegacyLoginCryptoError({ message: "cannot generate crypto keys: boom" }))
      : Effect.succeed({
          ecdh: {} as import("node:crypto").ECDH,
          publicKeyHex: opts.publicKeyHex ?? "04abcd",
        }),
    generateSessionId: Effect.sync(() => opts.sessionId ?? "test-session-id"),
    defaultTokenName: Effect.sync(() => opts.tokenName ?? "cli_test@host_123"),
    decryptToken: () =>
      opts.decryptFails
        ? Effect.fail(
            new LegacyLoginDecryptError({
              message: "cannot decrypt access token: cipher: message authentication failed",
            }),
          )
        : Effect.succeed(opts.decryptedToken ?? LEGACY_VALID_TOKEN),
  });
  return { layer };
}

export function mockLegacyLoginApi(
  opts: {
    readonly sessionResponse?: Partial<LegacyLoginSessionResponse>;
    // Number of `fetchLoginSession` failures before it succeeds (drives the
    // verification retry loop).
    readonly failTimes?: number;
    // `gotrue_id` returned by `fetchGotrueId` (Some); `profileFails` returns None.
    readonly gotrueId?: string;
    readonly profileFails?: boolean;
  } = {},
): {
  readonly layer: Layer.Layer<LegacyLoginApi>;
  readonly loginCallCount: number;
  readonly gotrueCallCount: number;
} {
  let loginCallCount = 0;
  let gotrueCallCount = 0;
  const failTimes = opts.failTimes ?? 0;
  const session: LegacyLoginSessionResponse = {
    access_token: "656e6372797074656420746f6b656e",
    public_key: "04abcd",
    nonce: "0102030405060708090a0b0c",
    ...opts.sessionResponse,
  };
  const layer = Layer.succeed(LegacyLoginApi, {
    fetchLoginSession: () => {
      loginCallCount += 1;
      if (loginCallCount <= failTimes) {
        return Effect.fail(
          new LegacyLoginVerificationError({ message: "Error status 404: not found" }),
        );
      }
      return Effect.succeed(session);
    },
    fetchGotrueId: () => {
      gotrueCallCount += 1;
      if (opts.profileFails === true) return Effect.succeed(Option.none<string>());
      return Effect.succeed(Option.some(opts.gotrueId ?? "gotrue-user-123"));
    },
  });
  return {
    layer,
    get loginCallCount() {
      return loginCallCount;
    },
    get gotrueCallCount() {
      return gotrueCallCount;
    },
  };
}

// ---------------------------------------------------------------------------
// State-tracking factories — for PersistentPostRun-parity assertions
// (telemetry must flush, linked-project cache fires after ref resolution).
// Shape matches the inline helpers the 9 native-port tests used pre-extraction.
// ---------------------------------------------------------------------------

export function mockLegacyTelemetryStateTracked(): {
  readonly layer: Layer.Layer<LegacyTelemetryState>;
  readonly flushed: boolean;
  /**
   * Number of `flush` calls — beyond the plain `flushed` boolean, this lets a
   * test prove a command's own `Effect.ensuring` finalizer fired EXACTLY once
   * even when its body calls an in-process helper (e.g. `legacyResetLocalDatabase`,
   * CLI-2062) that could, if it wrongly owned a second finalizer, double the
   * count instead of leaving it at 1.
   */
  readonly flushCount: number;
  readonly stitchedDistinctId: string | undefined;
  readonly clearedDistinctId: boolean;
  readonly identityReset: boolean;
} {
  let flushed = false;
  let flushCount = 0;
  let stitchedDistinctId: string | undefined;
  let clearedDistinctId = false;
  let identityReset = false;
  const layer = Layer.succeed(LegacyTelemetryState, {
    get flush() {
      return Effect.sync(() => {
        flushed = true;
        flushCount += 1;
      });
    },
    stitchLogin: (distinctId: string) =>
      Effect.sync(() => {
        stitchedDistinctId = distinctId;
      }),
    get clearDistinctId() {
      return Effect.sync(() => {
        clearedDistinctId = true;
      });
    },
    get resetIdentity() {
      return Effect.sync(() => {
        identityReset = true;
      });
    },
  });
  return {
    layer,
    get flushed() {
      return flushed;
    },
    get flushCount() {
      return flushCount;
    },
    get stitchedDistinctId() {
      return stitchedDistinctId;
    },
    get clearedDistinctId() {
      return clearedDistinctId;
    },
    get identityReset() {
      return identityReset;
    },
  };
}

export function mockLegacyLinkedProjectCacheTracked(): {
  readonly layer: Layer.Layer<LegacyLinkedProjectCache>;
  readonly cached: boolean;
  /** Number of `cache` calls — see {@link mockLegacyTelemetryStateTracked}'s own `flushCount`. */
  readonly cacheCount: number;
  readonly cachedRef: string | undefined;
  readonly cachedApiUrl: string | undefined;
  readonly cachedAccessToken: Option.Option<Redacted.Redacted<string>> | undefined;
} {
  let cached = false;
  let cacheCount = 0;
  let cachedRef: string | undefined;
  let cachedApiUrl: string | undefined;
  let cachedAccessToken: Option.Option<Redacted.Redacted<string>> | undefined;
  const layer = Layer.succeed(LegacyLinkedProjectCache, {
    cache: (
      ref: string,
      _workdir?: string,
      apiUrl?: string,
      accessToken?: Option.Option<Redacted.Redacted<string>>,
    ) =>
      Effect.sync(() => {
        cached = true;
        cacheCount += 1;
        cachedRef = ref;
        cachedApiUrl = apiUrl;
        cachedAccessToken = accessToken;
      }),
  });
  return {
    layer,
    get cached() {
      return cached;
    },
    get cacheCount() {
      return cacheCount;
    },
    get cachedRef() {
      return cachedRef;
    },
    get cachedApiUrl() {
      return cachedApiUrl;
    },
    get cachedAccessToken() {
      return cachedAccessToken;
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
  readonly poolerHost?: string;
  readonly dashboardUrl?: string;
  readonly accessToken?: Option.Option<Redacted.Redacted<string>>;
  readonly projectId?: Option.Option<string>;
  readonly userAgent?: string;
}): Layer.Layer<LegacyCliConfig> {
  return Layer.succeed(LegacyCliConfig, {
    profile: opts.profile ?? "supabase",
    apiUrl: opts.apiUrl ?? LEGACY_DEFAULT_API_URL,
    projectHost: opts.projectHost ?? "supabase.co",
    poolerHost: opts.poolerHost ?? "supabase.com",
    dashboardUrl: opts.dashboardUrl ?? "https://supabase.com/dashboard",
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
  // Wraps `layer` in a `LegacyPlatformApiFactory` for commands that switched
  // from yielding `LegacyPlatformApi` directly to the lazy factory shape.
  readonly factoryLayer: Layer.Layer<LegacyPlatformApiFactory>;
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

  const factoryLayer = Layer.succeed(LegacyPlatformApiFactory, {
    make: LegacyPlatformApi.pipe(Effect.provide(layer)),
  });

  return { layer, httpClientLayer, requests, factoryLayer };
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

  // The legacy shell is a Go-parity port and only calls v1 operations, so v2
  // has no stub support — any v2 call from legacy code is a wiring bug.
  const v2Proxy = new Proxy({} as ApiClient["v2"], {
    get(_target, prop: string) {
      return () => Effect.die(`Unmocked LegacyPlatformApi.v2.${prop}`);
    },
  });

  const layer = Layer.succeed(LegacyPlatformApi, {
    v1: v1Proxy,
    v2: v2Proxy,
    // Direct-service consumers don't exercise the raw-execute escape hatch.
    executeRaw: () => Effect.die("Unmocked LegacyPlatformApi.executeRaw"),
  } as ApiClient);

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

/**
 * Pins `SUPABASE_SHADOW_CACHE=0` for every test in the calling file, restoring whatever the host
 * had afterwards. Like {@link useLegacyTempWorkdir} it calls vitest's `beforeEach`/`afterEach`
 * internally, so it must be invoked at module scope (or inside the surrounding `describe`).
 *
 * The shadow baseline cache (`db-bootstrap/shadow-cache.ts`) is ON by default and reads
 * `process.env` directly, so ANY suite that provisions a shadow through
 * `legacyWithShadowDatabase` with a mocked spawner — `db diff`, `db pull`, declarative sync — now
 * exercises the cache path unless it opts out: the cold path adds a `docker stop`/`docker cp`/
 * `docker start` round trip and writes a ~90MB-shaped tar into the test's workdir. Suites whose
 * subject is anything OTHER than the cache should call this so they keep asserting the plain
 * container lifecycle; the cache's own suites deliberately do not.
 */
export function useLegacyShadowCacheDisabled(): void {
  const name = "SUPABASE_SHADOW_CACHE";
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[name];
    process.env[name] = "0";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    previous = undefined;
  });
}

/**
 * The opposite direction of {@link useLegacyShadowCacheDisabled}, scoped to ONE effect rather than
 * a whole file: turns the shadow baseline cache back on for `body` and roots it at `homeDir`,
 * restoring whatever the host had afterwards. Both variables have to move together — the cache
 * reads `SUPABASE_SHADOW_CACHE` for the gate and `SUPABASE_HOME` for the tar directory
 * (`legacyShadowBaselineCacheDir`), so pinning only the gate would write ~90MB-shaped tars into
 * the developer's real `~/.supabase`.
 *
 * For a suite that has opted out file-wide, this is how a single cache-focused scenario opts back
 * in. Point `homeDir` at a per-test temp dir (see {@link useLegacyTempWorkdir}).
 */
export const withLegacyShadowCacheEnabled = <A, E, R>(
  homeDir: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        cache: process.env["SUPABASE_SHADOW_CACHE"],
        home: process.env["SUPABASE_HOME"],
      };
      process.env["SUPABASE_SHADOW_CACHE"] = "1";
      process.env["SUPABASE_HOME"] = homeDir;
      return previous;
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of [
          ["SUPABASE_SHADOW_CACHE", previous.cache],
          ["SUPABASE_HOME", previous.home],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );

/**
 * Ambient isolation for tests that construct the REAL `legacyCliConfigLayer` /
 * `legacyCredentialsLayer` (directly or inside a command runtime layer) against
 * a real filesystem. Those layers read `<homeDir>/.supabase/profile` and
 * `<homeDir>/.supabase/access-token`, resolving `SUPABASE_HOME` /
 * `SUPABASE_PROFILE` from the raw process env — so both the home directory and
 * the env must be pinned or stale files and ambient variables on the host
 * machine leak into the test.
 *
 * Point `homeDir` at a per-test temp dir (see {@link useLegacyTempWorkdir});
 * `env` replaces the entire ambient env for the layer's lifetime, so list every
 * variable the test needs (e.g. `SUPABASE_ACCESS_TOKEN`, `SUPABASE_NO_KEYRING`).
 */
export function legacyIsolatedHomeLayer(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Layer.Layer<RuntimeInfo> {
  return Layer.mergeAll(mockRuntimeInfo({ homeDir }), processEnvLayer(env));
}

// ---------------------------------------------------------------------------
// Failing filesystem — wraps the real Bun `FileSystem` and fails a chosen
// `writeFileString` with a `PlatformError`, so cleanup-on-failure paths
// (e.g. the pg-delta multi-file migration writer) can be exercised
// deterministically. Every other call delegates to the real filesystem, so
// config reads / earlier writes behave normally. Merge this AFTER
// `BunServices.layer` (last-wins) so it overrides only `FileSystem`; `Path`
// still comes from `BunServices`.
// ---------------------------------------------------------------------------

export function legacyFailWriteStringOnNthCallFsLayer(
  failOnCall: number,
): Layer.Layer<FileSystem.FileSystem> {
  return legacyFailWriteStringFsLayer((_, calls) => calls === failOnCall);
}

/**
 * Same as {@link legacyFailWriteStringOnNthCallFsLayer}, but fails the first
 * `writeFileString` whose path matches `match`. Prefer this when earlier
 * setup writes (shadow SQL, branch markers) make a fixed call index brittle.
 */
export function legacyFailWriteStringMatchingFsLayer(
  match: (path: string) => boolean,
): Layer.Layer<FileSystem.FileSystem> {
  return legacyFailWriteStringFsLayer((path) => match(path));
}

function legacyFailWriteStringFsLayer(
  shouldFail: (path: string, calls: number) => boolean,
): Layer.Layer<FileSystem.FileSystem> {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => {
      let calls = 0;
      return FileSystem.FileSystem.of({
        ...real,
        writeFileString: (path, data, options) => {
          calls += 1;
          if (shouldFail(path, calls)) {
            return Effect.fail(
              new PlatformError(
                new SystemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: path,
                  description: "simulated write failure",
                }),
              ),
            );
          }
          return real.writeFileString(path, data, options);
        },
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

// ---------------------------------------------------------------------------
// Shadow-database container-CLI spawner — shared by `db diff`/`db pull`'s native
// shadow-provisioning integration tests (CLI-1956). Hoisted here (it was a verbatim
// ~55-line duplicate in both `diff.integration.test.ts` and `pull.integration.test.ts`)
// per `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule.
// ---------------------------------------------------------------------------

/** The shadow container's fake id — used both as `docker create`'s stdout and the `dbHost` `.slice(0, 12)` derives from. */
export const LEGACY_FAKE_SHADOW_CONTAINER_ID = "abc123456789shadow0".padEnd(64, "0").slice(0, 64);

/** Go's `container.HealthConfig`-shaped inspect JSON for a healthy container. */
const LEGACY_SHADOW_HEALTHY_STATE =
  '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';

/**
 * Fakes every `docker`/`podman` subprocess call the native shadow-provisioning path issues
 * (`legacyBuildLocalDbContainerInputs`'s image-cache check, `legacyCreateShadowDatabase`'s
 * network-create + container create/start, `legacyWaitForShadowReady`'s container
 * inspect, and `legacyRemoveShadowDatabase`'s cleanup) — scoped-down port of
 * `start.integration.test.ts`'s own `mockContainerCliSpawner`, since both callers only ever
 * create one (shadow) container, never named.
 *
 * `container inspect` on the shadow's own id always reports `"healthy"`: no shadow consumer
 * gates on the Docker healthcheck any more — they all wait on `legacyWaitForShadowReady`'s direct
 * connect probe instead, so a suite that needs a shadow to stay un-ready refuses connects on the
 * shadow port through its own `LegacyDbConnection` fake (see `diff.integration.test.ts`'s
 * `neverConnectableShadow`) rather than faking a `"starting"` container.
 *
 * `failCreate`/`failRemove` (both default `false`) make `docker create`/`docker rm` exit
 * non-zero instead — hoisted from `migration squash`'s own scoped-down copy of this mock
 * (CLI-1969 review), which needed these two extra failure knobs `db diff`/`db pull`'s own
 * scenarios never exercised. Defaulting both to `false` keeps every existing caller
 * (`pull.integration.test.ts`, `declarative.orchestrate.integration.test.ts`,
 * `diff.integration.test.ts`) byte-identical.
 *
 * `dbNotRunning`/`dbInspectFailsWith` (CLI-1968) fake the SEPARATE `docker container inspect
 * supabase_db_<projectId>` probe `legacyIsLocalDbRunning` issues before `--use-pgadmin`
 * provisions anything — distinguished from the shadow's own `container inspect <64-hex-id>`
 * health probe by the target id's `supabase_db_` prefix, so both options leave the shadow's
 * own health check on its normal path. `dbNotRunning` reports the
 * Go/Docker "container doesn't exist" shape (`legacyIsContainerNotFoundMessage`); mutually
 * exclusive with `dbInspectFailsWith`, which instead reports a daemon-unreachable failure
 * (`legacyIsDockerDaemonUnreachable`) with the given stderr text — enforced below (a test
 * that sets both throws immediately, rather than one option silently winning).
 */
export function mockLegacyShadowContainerCliSpawner(
  opts: {
    readonly failCreate?: boolean;
    readonly failRemove?: boolean;
    readonly dbNotRunning?: boolean;
    readonly dbInspectFailsWith?: string;
  } = {},
): {
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly spawned: ReadonlyArray<{ readonly args: ReadonlyArray<string> }>;
} {
  if (opts.dbNotRunning === true && opts.dbInspectFailsWith !== undefined) {
    throw new Error(
      "mockLegacyShadowContainerCliSpawner: dbNotRunning and dbInspectFailsWith are mutually exclusive",
    );
  }
  const failCreate = opts.failCreate ?? false;
  const failRemove = opts.failRemove ?? false;
  const spawned: Array<{ readonly args: ReadonlyArray<string> }> = [];
  const encoder = new TextEncoder();

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = command._tag === "StandardCommand" ? command.args : [];
        spawned.push({ args });
        if (command._tag !== "StandardCommand") {
          return yield* Effect.fail(
            new PlatformError(
              new SystemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                description: "spawn failed",
              }),
            ),
          );
        }
        const isLocalDbInspect =
          args[0] === "container" &&
          args[1] === "inspect" &&
          (args[2] ?? "").startsWith("supabase_db_");
        if (
          isLocalDbInspect &&
          (opts.dbNotRunning === true || opts.dbInspectFailsWith !== undefined)
        ) {
          const stderrText =
            opts.dbInspectFailsWith ?? `Error response from daemon: No such container: ${args[2]}`;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(7000 + spawned.length),
            stdout: Stream.empty,
            stderr: Stream.fromIterable([encoder.encode(stderrText)]),
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            isRunning: Effect.succeed(false),
            stdin: Sink.drain,
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }
        let stdoutLines: ReadonlyArray<string> = [];
        let stderrLines: ReadonlyArray<string> = [];
        let exitCode = 0;
        if (args[0] === "create") {
          if (failCreate) {
            exitCode = 1;
            stderrLines = ["network error"];
          } else {
            stdoutLines = [LEGACY_FAKE_SHADOW_CONTAINER_ID];
          }
        } else if (args[0] === "container" && args[1] === "inspect") {
          stdoutLines = [LEGACY_SHADOW_HEALTHY_STATE];
        } else if (args[0] === "rm") {
          if (failRemove) {
            exitCode = 1;
            stderrLines = ["boom removing container"];
          }
        }
        // "image inspect", "network create", "start" (and "rm -f -v" when not `failRemove`)
        // all succeed with no output.
        const stdoutBytes = stdoutLines.map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = stderrLines.map((line) => encoder.encode(`${line}\n`));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(7000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return { layer, spawned };
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
  /**
   * `Stdin` for prompts routed through `legacyPromptYesNo` (piped-answer reads on
   * a non-TTY, Go's `Console.ReadLine`). Defaults to a non-TTY stdin with no
   * piped input, i.e. every bounded read times out like Go's empty 100ms scan.
   */
  readonly stdin?: Layer.Layer<Stdin>;
  readonly processControl?: { readonly layer: Layer.Layer<ProcessControl> };
  readonly runtimeInfo?: Layer.Layer<RuntimeInfo>;
  readonly telemetry?: Layer.Layer<LegacyTelemetryState>;
  readonly linkedProjectCache?: Layer.Layer<LegacyLinkedProjectCache>;
  readonly analytics?: { readonly layer: Layer.Layer<Analytics> };
  readonly goOutput?: Option.Option<GoOutputValue>;
  /** Raw argv seen by the handler (e.g. to exercise an explicit `--yes=false`). */
  readonly cliArgs?: ReadonlyArray<string>;
}

export function buildLegacyTestRuntime(opts: BuildLegacyTestRuntimeOpts) {
  const tty = opts.tty ?? mockTty({ stdinIsTty: false, stdoutIsTty: false });
  const stdin = opts.stdin ?? mockStdin(false);
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

  const topLevelFactory = Layer.succeed(LegacyPlatformApiFactory, {
    make: LegacyPlatformApi.pipe(Effect.provide(opts.api.layer)),
  });

  return Layer.mergeAll(
    opts.out.layer,
    opts.api.layer,
    topLevelFactory,
    opts.cliConfig,
    tty,
    stdin,
    processControl,
    runtimeInfo,
    legacyProjectRefLayer.pipe(
      Layer.provide(
        Layer.succeed(LegacyPlatformApiFactory, {
          make: LegacyPlatformApi.pipe(Effect.provide(opts.api.layer)),
        }),
      ),
      Layer.provide(opts.cliConfig),
      Layer.provide(tty),
      Layer.provide(opts.out.layer),
      Layer.provide(BunServices.layer),
    ),
    BunServices.layer,
    Layer.succeed(LegacyOutputFlag, goOutput),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    linkedProjectCache,
    telemetry,
    analytics,
    mockLegacyCredentialsLayer,
    httpClient ?? noopHttpClient,
  );
}
