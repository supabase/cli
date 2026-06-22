import { describe, expect, it } from "@effect/vitest";

import {
  legacyBucketObjectKey,
  legacyContentTypeForPath,
  legacyParseFileSizeLimit,
} from "./buckets.upload.ts";

describe("legacyBucketObjectKey", () => {
  it("maps a single-file objects_path to <bucket>/<basename>", () => {
    expect(legacyBucketObjectKey("docs", "assets/file.pdf", "assets/file.pdf")).toBe(
      "docs/file.pdf",
    );
  });

  it("maps a direct child to <bucket>/<name>", () => {
    expect(legacyBucketObjectKey("docs", "assets", "assets/a.txt")).toBe("docs/a.txt");
  });

  it("maps a nested file to <bucket>/<relative-posix-path>", () => {
    expect(legacyBucketObjectKey("docs", "assets", "assets/sub/dir/b.txt")).toBe(
      "docs/sub/dir/b.txt",
    );
  });

  it("normalises a leading ./ in objects_path", () => {
    expect(legacyBucketObjectKey("docs", "./assets", "assets/a.txt")).toBe("docs/a.txt");
  });
});

describe("legacyParseFileSizeLimit", () => {
  it("parses a human-readable size to bytes", () => {
    expect(legacyParseFileSizeLimit("50MiB")).toBe(50 * 1024 * 1024);
  });

  it("returns 0 for a zero limit", () => {
    expect(legacyParseFileSizeLimit("0")).toBe(0);
  });

  it("throws on an unparseable value", () => {
    expect(() => legacyParseFileSizeLimit("not-a-size")).toThrow();
  });

  it("accepts Go-valid numeral forms (strconv.ParseFloat parity)", () => {
    // docker/go-units RAMInBytes hands the numeric part to strconv.ParseFloat,
    // which accepts a leading/trailing dot, exponent, sign, and underscores
    // between digits (Go 1.13+ literal rule).
    expect(legacyParseFileSizeLimit(".5MiB")).toBe(Math.trunc(0.5 * 1024 * 1024));
    expect(legacyParseFileSizeLimit("1.MiB")).toBe(1024 * 1024);
    expect(legacyParseFileSizeLimit("1e6")).toBe(1_000_000);
    expect(legacyParseFileSizeLimit("1_000MiB")).toBe(1000 * 1024 * 1024);
    expect(legacyParseFileSizeLimit("1_0MiB")).toBe(10 * 1024 * 1024);
  });

  it("rejects badly-placed underscores (Go literal rule)", () => {
    // Underscores only between digits — no leading/trailing/doubled.
    expect(() => legacyParseFileSizeLimit("_1000MiB")).toThrow("invalid size");
    expect(() => legacyParseFileSizeLimit("1__0MiB")).toThrow("invalid size");
  });

  it("rejects malformed numerals that JS parseFloat would truncate", () => {
    // strconv.ParseFloat rejects the whole string; JS parseFloat parses a prefix.
    expect(() => legacyParseFileSizeLimit("1.2.3MiB")).toThrow("invalid size");
    expect(() => legacyParseFileSizeLimit("1 2MiB")).toThrow("invalid size");
    expect(() => legacyParseFileSizeLimit("-5MiB")).toThrow("invalid size");
  });

  it("rejects an overflowing numeral (Go ParseFloat range error)", () => {
    // 1e309 parses to Infinity in JS; Go's strconv.ParseFloat returns a range error.
    expect(() => legacyParseFileSizeLimit("1e309")).toThrow("invalid size");
  });
});

describe("legacyContentTypeForPath", () => {
  it("maps a known extension", () => {
    expect(legacyContentTypeForPath("/x/a.png")).toBe("image/png");
    expect(legacyContentTypeForPath("/x/a.json")).toBe("application/json");
  });

  it("is case-insensitive on the extension", () => {
    expect(legacyContentTypeForPath("/x/A.JSON")).toBe("application/json");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(legacyContentTypeForPath("/x/a.unknownext")).toBe("application/octet-stream");
    expect(legacyContentTypeForPath("/x/noext")).toBe("application/octet-stream");
  });
});
