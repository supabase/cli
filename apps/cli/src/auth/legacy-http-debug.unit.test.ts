import { describe, expect, test } from "vitest";
import { legacyRedactHttpUrl } from "./legacy-http-debug.layer.ts";

/**
 * `--debug` logs every request URL to stderr. For a presigned object-store URL
 * the query string *is* the credential — for the Workers build-context upload,
 * one that authorizes overwriting the archive a deploy is about to build from —
 * so it must not survive into scrollback or a CI log.
 */
describe("legacyRedactHttpUrl", () => {
  test.each([
    [
      "an AWS presigned upload",
      "https://store.example/bucket/ctx.tar.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef",
      "https://store.example/bucket/ctx.tar.gz?<redacted>",
    ],
    [
      "a GCS presigned upload",
      "https://store.example/bucket/ctx.tar.gz?X-Goog-Signature=deadbeef",
      "https://store.example/bucket/ctx.tar.gz?<redacted>",
    ],
    [
      "a lowercase signature parameter",
      "https://store.example/o/ctx?signature=deadbeef&expires=123",
      "https://store.example/o/ctx?<redacted>",
    ],
    [
      "a bare token parameter",
      "https://store.example/o/ctx?token=deadbeef",
      "https://store.example/o/ctx?<redacted>",
    ],
  ])("redacts the query string of %s", (_label, url, expected) => {
    expect(legacyRedactHttpUrl(url)).toBe(expected);
    expect(legacyRedactHttpUrl(url)).not.toContain("deadbeef");
  });

  // The debug log is only useful if ordinary requests still read normally, so
  // redaction has to be the exception rather than the rule.
  test.each([
    ["a Management API route", "https://api.supabase.com/v2/projects/abc/workers/api"],
    ["an ordinary query string", "https://api.supabase.com/v1/projects?limit=10"],
    ["a URL with no query at all", "https://api.supabase.com/v1/projects"],
  ])("leaves %s untouched", (_label, url) => {
    expect(legacyRedactHttpUrl(url)).toBe(url);
  });

  test("passes through something that is not a parseable URL", () => {
    expect(legacyRedactHttpUrl("not a url at all")).toBe("not a url at all");
  });

  test("keeps the path, which is what makes the log line worth having", () => {
    expect(legacyRedactHttpUrl("https://store.example/bucket/deep/ctx.tar.gz?sig=x")).toContain(
      "/bucket/deep/ctx.tar.gz",
    );
  });
});
