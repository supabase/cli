import { describe, expect, it } from "vitest";

import {
  LegacyGoUrlParseError,
  LegacyStorageUrlPatternError,
  legacyDetectScheme,
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
