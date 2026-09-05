import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { LegacyDebugLoggerShape } from "../../shared/legacy-debug-logger.service.ts";
import { legacyFeedbackFetch } from "./feedback.layers.ts";

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

function recordingInnerFetch() {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response("ok");
    },
    { preconnect: () => Promise.resolve() },
  );
  return { fetch, requests };
}

describe("legacyFeedbackFetch", () => {
  it("logs every request through the debug logger and delegates to the inner fetch", async () => {
    const { logger, httpLines } = recordingLogger();
    const inner = recordingInnerFetch();
    const fetch = legacyFeedbackFetch({ dnsResolver: "native", logger, innerFetch: inner.fetch });

    const response = await fetch("https://feedback.supabase.co/rest/v1/rpc/x", { method: "POST" });

    expect(await response.text()).toBe("ok");
    expect(httpLines).toEqual(["POST https://feedback.supabase.co/rest/v1/rpc/x"]);
    expect(inner.requests).toEqual([
      { url: "https://feedback.supabase.co/rest/v1/rpc/x", method: "POST" },
    ]);
  });

  it("defaults the logged method to GET when the request carries none", async () => {
    const { logger, httpLines } = recordingLogger();
    const inner = recordingInnerFetch();
    const fetch = legacyFeedbackFetch({ dnsResolver: "native", logger, innerFetch: inner.fetch });

    await fetch("https://feedback.supabase.co/rest/v1/interfaces_feedback");

    expect(httpLines).toEqual(["GET https://feedback.supabase.co/rest/v1/interfaces_feedback"]);
  });

  it("redacts the delete_token filter from the logged URL but not the request", async () => {
    const { logger, httpLines } = recordingLogger();
    const inner = recordingInnerFetch();
    const fetch = legacyFeedbackFetch({ dnsResolver: "native", logger, innerFetch: inner.fetch });

    // The preview/delete URL carries the capability token as a PostgREST
    // filter; the debug log must never reproduce it.
    const url =
      "https://feedback.supabase.co/rest/v1/interfaces_feedback" +
      "?select=feedback&delete_token=eq.123e4567-e89b-12d3-a456-426614174000";
    await fetch(url, { method: "DELETE" });

    expect(httpLines).toEqual([
      "DELETE https://feedback.supabase.co/rest/v1/interfaces_feedback" +
        "?select=feedback&delete_token=eq.redacted",
    ]);
    // The transport still receives the original, unredacted URL.
    expect(inner.requests).toEqual([{ url, method: "DELETE" }]);
  });
});
