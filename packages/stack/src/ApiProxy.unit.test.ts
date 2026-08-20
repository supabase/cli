import { Headers } from "effect/unstable/http";
import { describe, expect, test } from "vitest";
import { hasRequestBody, isReplayableBodySize, sanitizeProxyRequestHeaders } from "./ApiProxy.ts";

// The gateway must forward HttpBody.empty for bodyless requests: streaming a
// nonexistent body upstream fails with a transport error (a 502 to clients).
// This predicate is the guard; the Bun server rejects empty-body streams, so
// the Node-backed integration suite cannot cover these cases end to end.
describe("hasRequestBody", () => {
  test("no framing headers means no body", () => {
    expect(hasRequestBody(Headers.fromInput({}))).toBe(false);
  });

  test.each(["0", "00", "0, 0"])("content-length %j is bodyless", (contentLength) => {
    expect(hasRequestBody(Headers.fromInput({ "content-length": contentLength }))).toBe(false);
  });

  test("positive content-length has a body", () => {
    expect(hasRequestBody(Headers.fromInput({ "content-length": "42" }))).toBe(true);
  });

  test("transfer-encoding alone has a body", () => {
    expect(hasRequestBody(Headers.fromInput({ "transfer-encoding": "chunked" }))).toBe(true);
  });

  test("transfer-encoding takes precedence over content-length", () => {
    expect(
      hasRequestBody(Headers.fromInput({ "transfer-encoding": "chunked", "content-length": "0" })),
    ).toBe(true);
  });

  test.each(["5, 5", "abc"])(
    "non-zero or malformed content-length %j errs toward having a body",
    (contentLength) => {
      expect(hasRequestBody(Headers.fromInput({ "content-length": contentLength }))).toBe(true);
    },
  );
});

// The proxy transport (node:http) frames the forwarded body from the headers
// it is given: content-length must be preserved byte-exact (storage size
// limits, S3 SigV4), while the hop-by-hop transfer-encoding is re-added by
// the transport itself when no length is known.
describe("sanitizeProxyRequestHeaders", () => {
  test("strips transfer-encoding and keeps content-length and the rest", () => {
    const sanitized = sanitizeProxyRequestHeaders(
      Headers.fromInput({
        "transfer-encoding": "chunked",
        "content-length": "42",
        "content-type": "application/json",
        authorization: "Bearer token",
      }),
    );
    expect(sanitized["transfer-encoding"]).toBeUndefined();
    expect(sanitized["content-length"]).toBe("42");
    expect(sanitized["content-type"]).toBe("application/json");
    expect(sanitized["authorization"]).toBe("Bearer token");
  });
});

// Cold-start retry may only re-send bodies it can buffer whole; everything
// else must stream through without retry.
describe("isReplayableBodySize", () => {
  test("small content-length is replayable", () => {
    expect(isReplayableBodySize(Headers.fromInput({ "content-length": "1024" }))).toBe(true);
  });

  test("content-length at the 1 MiB cap is replayable", () => {
    expect(isReplayableBodySize(Headers.fromInput({ "content-length": String(1024 * 1024) }))).toBe(
      true,
    );
  });

  test("content-length above the cap is not replayable", () => {
    expect(
      isReplayableBodySize(Headers.fromInput({ "content-length": String(1024 * 1024 + 1) })),
    ).toBe(false);
  });

  test("unsized (chunked) bodies are not replayable", () => {
    expect(isReplayableBodySize(Headers.fromInput({ "transfer-encoding": "chunked" }))).toBe(false);
  });
});
