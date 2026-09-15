import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { DebugLoggerShape } from "../../command-internal/debug-logger.service.ts";
import { feedbackFetch } from "./feedback.layers.ts";

function recordingLogger() {
  const httpLines: Array<string> = [];
  const logger: DebugLoggerShape = {
    debug: () => Effect.void,
    http: (method, url) =>
      Effect.sync(() => {
        httpLines.push(`${method} ${url}`);
      }),
  };
  return { logger, httpLines };
}

function recordingInnerFetch() {
  const requests: Array<{ url: string; method: string | undefined; hasInit: boolean }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), method: init?.method, hasInit: init !== undefined });
      return Promise.resolve(new Response("ok"));
    },
    { preconnect: () => Promise.resolve() },
  );
  return { fetch, requests };
}

describe("feedbackFetch", () => {
  it.live("logs every request through the debug logger and delegates to the inner fetch", () =>
    Effect.gen(function* () {
      const { logger, httpLines } = recordingLogger();
      const inner = recordingInnerFetch();
      const fetch = feedbackFetch({ dnsResolver: "native", logger, innerFetch: inner.fetch });

      const response = yield* Effect.promise((signal) =>
        fetch("https://feedback.supabase.co/rest/v1/rpc/x", { method: "POST", signal }),
      );

      expect(yield* Effect.promise(() => response.text())).toBe("ok");
      expect(httpLines).toEqual(["POST https://feedback.supabase.co/rest/v1/rpc/x"]);
      expect(inner.requests).toEqual([
        { url: "https://feedback.supabase.co/rest/v1/rpc/x", method: "POST", hasInit: true },
      ]);
    }),
  );

  it.live("defaults the logged method to GET when the request carries none", () =>
    Effect.gen(function* () {
      const { logger, httpLines } = recordingLogger();
      const inner = recordingInnerFetch();
      const fetch = feedbackFetch({ dnsResolver: "native", logger, innerFetch: inner.fetch });

      // Deliberately no init at all: pins the undefined-init passthrough to the transport.
      yield* Effect.promise(() =>
        fetch("https://feedback.supabase.co/rest/v1/interfaces_feedback"),
      );

      expect(httpLines).toEqual(["GET https://feedback.supabase.co/rest/v1/interfaces_feedback"]);
      expect(inner.requests).toEqual([
        {
          url: "https://feedback.supabase.co/rest/v1/interfaces_feedback",
          method: undefined,
          hasInit: false,
        },
      ]);
    }),
  );

  it.live("redacts the delete_token filter from the logged URL but not the request", () =>
    Effect.gen(function* () {
      const { logger, httpLines } = recordingLogger();
      const inner = recordingInnerFetch();
      const fetch = feedbackFetch({ dnsResolver: "native", logger, innerFetch: inner.fetch });

      // The delete URL carries the capability token as a PostgREST
      // filter; the debug log must never reproduce it.
      const url =
        "https://feedback.supabase.co/rest/v1/interfaces_feedback" +
        "?select=feedback&delete_token=eq.123e4567-e89b-12d3-a456-426614174000";
      yield* Effect.promise((signal) => fetch(url, { method: "DELETE", signal }));

      expect(httpLines).toEqual([
        "DELETE https://feedback.supabase.co/rest/v1/interfaces_feedback" +
          "?select=feedback&delete_token=eq.redacted",
      ]);
      // The transport still receives the original, unredacted URL.
      expect(inner.requests).toEqual([{ url, method: "DELETE", hasInit: true }]);
    }),
  );
});
