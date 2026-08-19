import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { feedbackClientLayer } from "../../../shared/feedback/feedback-client.layer.ts";
import { FeedbackClient } from "../../../shared/feedback/feedback-client.service.ts";
import type { LegacyDebugLoggerShape } from "../../shared/legacy-debug-logger.service.ts";
import { legacyFeedbackFetch } from "./feedback.layers.ts";

// The environment only needs a url/key shape — no request leaves the test.
// The hostname must NOT be an IP literal so the DoH rewrite branch runs.
const TEST_ENV = {
  url: "https://feedback-project.supabase.co",
  key: "sb_publishable_test_key",
};

const TOKEN = "123e4567-e89b-12d3-a456-426614174000";
const RESOLVED_IP = "203.0.113.10";

const SUBMISSION = {
  message: "port conflicts when running two stacks",
  context: {
    cliVersion: "9.9.9",
    userAgent: "SupabaseCLI/9.9.9",
    os: "darwin",
    arch: "arm64",
    isAgent: false,
  },
};

function recordingLogger() {
  const httpLines: Array<string> = [];
  const logger: LegacyDebugLoggerShape = {
    debug: () => Effect.void,
    http: (method, url) =>
      Effect.sync(() => {
        httpLines.push(`${method} ${url}`);
      }),
  };
  return { logger, httpLines };
}

function recordingInnerFetch(respond: () => Response) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, headers: new Headers(init?.headers) });
      return respond();
    },
    { preconnect: () => Promise.resolve() },
  );
  return { fetch, requests };
}

// The full production transport stack minus the network: real supabase-js
// client → real `legacyFeedbackFetch` (debug logging + DoH rewrite) → recording
// inner fetch, with only the DoH resolver faked. This pins the shape supabase-js
// hands to the transport (a WHATWG `Headers` instance) — the regression where a
// plain-object spread dropped every header only reproduces with that shape.
function setupLegacyDohTransport(respond: () => Response) {
  const { logger, httpLines } = recordingLogger();
  const inner = recordingInnerFetch(respond);
  const layer = feedbackClientLayer({
    environment: TEST_ENV,
    fetch: legacyFeedbackFetch({
      dnsResolver: "https",
      logger,
      innerFetch: inner.fetch,
      resolver: () => Effect.succeed([RESOLVED_IP]),
    }),
  });
  return { layer, httpLines, requests: inner.requests };
}

describe("legacyFeedbackFetch with --dns-resolver https", () => {
  it.live("preserves supabase-js auth headers through the DoH rewrite on submit", () => {
    const { layer, requests } = setupLegacyDohTransport(
      () =>
        new Response(JSON.stringify(TOKEN), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    return Effect.gen(function* () {
      const client = yield* FeedbackClient;
      const receipt = yield* client.submit(SUBMISSION);

      expect(receipt).toEqual({ deleteToken: TOKEN });
      expect(requests).toHaveLength(1);
      const { url, headers } = requests[0]!;
      // The connection dials the resolved IP while TLS/Host still target the
      // original hostname.
      expect(new URL(url).hostname).toBe(RESOLVED_IP);
      expect(headers.get("host")).toBe("feedback-project.supabase.co");
      // supabase-js supplies these as a `Headers` instance; they must survive
      // the rewrite or PostgREST rejects the request.
      expect(headers.get("apikey")).toBe(TEST_ENV.key);
      expect(headers.get("content-type")).toContain("application/json");
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves the x-feedback-token capability header through the DoH rewrite on delete", () => {
    const { layer, requests } = setupLegacyDohTransport(
      () => new Response(null, { status: 204, headers: { "content-range": "*/1" } }),
    );
    return Effect.gen(function* () {
      const client = yield* FeedbackClient;
      const result = yield* client.delete(TOKEN);

      expect(result).toEqual({ deleted: true });
      expect(requests[0]!.headers.get("x-feedback-token")).toBe(TOKEN);
      expect(requests[0]!.headers.get("apikey")).toBe(TEST_ENV.key);
    }).pipe(Effect.provide(layer));
  });
});
