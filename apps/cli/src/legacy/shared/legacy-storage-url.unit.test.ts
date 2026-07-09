import { describe, expect, it } from "vitest";

import {
  LegacyGoUrlParseError,
  LegacyStorageUrlPatternError,
  legacyDetectScheme,
  legacyGoUrlParse,
  legacyParseStorageUrl,
  legacySplitBucketPrefix,
  legacyStorageIsDir,
} from "./legacy-storage-url.ts";

// Oracle: apps/cli-go/internal/storage/client/scheme_test.go
describe("legacyParseStorageUrl", () => {
  it("parses a valid url to its path", () => {
    expect(legacyParseStorageUrl("ss:///bucket/folder/name.png")).toBe("/bucket/folder/name.png");
  });

  it("rejects a url with a host (ss://bucket)", () => {
    expect(() => legacyParseStorageUrl("ss://bucket")).toThrow(LegacyStorageUrlPatternError);
    expect(() => legacyParseStorageUrl("ss://bucket")).toThrow(
      "URL must match pattern ss:///bucket/[prefix]",
    );
  });

  it("rejects a url with no path (ss:)", () => {
    expect(() => legacyParseStorageUrl("ss:")).toThrow(LegacyStorageUrlPatternError);
  });

  it("rejects a url with the wrong scheme (.)", () => {
    expect(() => legacyParseStorageUrl(".")).toThrow(LegacyStorageUrlPatternError);
  });

  it("surfaces the url-parse error on a missing protocol scheme (:)", () => {
    expect(() => legacyParseStorageUrl(":")).toThrow(LegacyGoUrlParseError);
    expect(() => legacyParseStorageUrl(":")).toThrow("missing protocol scheme");
  });

  it("accepts an uppercase scheme (case-insensitive)", () => {
    expect(legacyParseStorageUrl("SS:///bucket/x")).toBe("/bucket/x");
  });

  it("rejects a malformed percent-escape in the path", () => {
    expect(() => legacyParseStorageUrl("ss:///bucket/a%2")).toThrow(LegacyGoUrlParseError);
    expect(() => legacyParseStorageUrl("ss:///bucket/a%2")).toThrow('invalid URL escape "%2"');
  });

  it("decodes percent-escapes in the path (ascii)", () => {
    expect(legacyParseStorageUrl("ss:///bucket/a%20b")).toBe("/bucket/a b");
  });

  it("decodes a multi-byte UTF-8 percent-escape as one rune (Go raw-byte path)", () => {
    // %E4%B8%AD is the UTF-8 encoding of 中 — decoded as one rune, not three.
    expect(legacyParseStorageUrl("ss:///bucket/%E4%B8%AD.txt")).toBe("/bucket/中.txt");
  });
});

// Oracle: SplitBucketPrefix sub-tests in scheme_test.go
describe("legacySplitBucketPrefix", () => {
  it.each([
    ["", ["", ""]],
    ["/", ["", ""]],
    ["bucket", ["bucket", ""]],
    ["/bucket", ["bucket", ""]],
    ["bucket/", ["bucket", ""]],
    ["/bucket/folder/name.png", ["bucket", "folder/name.png"]],
    ["/bucket/folder/", ["bucket", "folder/"]],
  ] as const)("splits %j → %j", (input, expected) => {
    expect(legacySplitBucketPrefix(input)).toEqual(expected);
  });
});

describe("legacyDetectScheme", () => {
  it.each([
    ["ss:///x", "ss"],
    ["readme.md", ""],
    ["/tmp/f", ""],
    ["SS://x", "ss"],
    [".", ""],
  ] as const)("detects %j → %j", (input, expected) => {
    expect(legacyDetectScheme(input)).toBe(expected);
  });

  it("throws on a missing protocol scheme", () => {
    expect(() => legacyDetectScheme(":")).toThrow("missing protocol scheme");
  });
});

// Oracle: `go run` against Go 1.25's `net/url.Parse` directly (net/url/url.go's
// `parseHost`) — used by `studio.api_url` validation, which needs the Host, not
// just Scheme/Path, so the failures below matter beyond the storage commands.
describe("legacyGoUrlParse (host validation)", () => {
  it("rejects an unterminated IPv6 literal", () => {
    expect(() => legacyGoUrlParse("http://[::1")).toThrow(LegacyGoUrlParseError);
    expect(() => legacyGoUrlParse("http://[::1")).toThrow(
      `parse "http://[::1": missing ']' in host`,
    );
  });

  it("accepts a bracketed IPv6 literal with no port", () => {
    expect(legacyGoUrlParse("http://[::1]").host).toBe("[::1]");
  });

  it("accepts a bracketed IPv6 literal with a valid port", () => {
    expect(legacyGoUrlParse("http://[::1]:8080").host).toBe("[::1]:8080");
  });

  it("rejects a bracketed IPv6 literal with a non-numeric port", () => {
    expect(() => legacyGoUrlParse("http://[::1]:abc")).toThrow(
      `parse "http://[::1]:abc": invalid port ":abc" after host`,
    );
  });

  it("rejects a bracket that isn't the first character of the host", () => {
    expect(() => legacyGoUrlParse("http://host[::1]")).toThrow(
      `parse "http://host[::1]": invalid IP-literal`,
    );
  });

  it("accepts a plain hostname with a numeric port", () => {
    expect(legacyGoUrlParse("http://example.com:99999").host).toBe("example.com:99999");
  });

  it("rejects more than one colon in an http(s) host (strict-colon default)", () => {
    expect(() => legacyGoUrlParse("http://host:1:2")).toThrow(
      `parse "http://host:1:2": invalid port ":1:2" after host`,
    );
  });

  it("does not validate a host for a scheme with no authority (ss:///bucket)", () => {
    expect(() => legacyGoUrlParse("ss:///bucket/x")).not.toThrow();
  });
});

describe("legacyStorageIsDir", () => {
  it.each([
    ["", true],
    ["a/", true],
    ["a", false],
    ["folder/name.png", false],
  ] as const)("classifies %j → %j", (input, expected) => {
    expect(legacyStorageIsDir(input)).toBe(expected);
  });
});
