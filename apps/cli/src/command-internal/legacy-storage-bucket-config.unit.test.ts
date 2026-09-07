import { describe, expect, it } from "vitest";

import {
  legacyBucketHasKey,
  legacyParseFileSizeLimit,
  legacyResolveBucketProps,
} from "./legacy-storage-bucket-config.ts";

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
    expect(legacyParseFileSizeLimit(".5MiB")).toBe(Math.trunc(0.5 * 1024 * 1024));
    expect(legacyParseFileSizeLimit("1.MiB")).toBe(1024 * 1024);
    expect(legacyParseFileSizeLimit("1e6")).toBe(1_000_000);
    expect(legacyParseFileSizeLimit("1_000MiB")).toBe(1000 * 1024 * 1024);
    expect(legacyParseFileSizeLimit("1_0MiB")).toBe(10 * 1024 * 1024);
  });

  it("rejects badly-placed underscores (Go literal rule)", () => {
    expect(() => legacyParseFileSizeLimit("_1000MiB")).toThrow("invalid size");
    expect(() => legacyParseFileSizeLimit("1__0MiB")).toThrow("invalid size");
  });

  it("rejects malformed numerals that JS parseFloat would truncate", () => {
    expect(() => legacyParseFileSizeLimit("1.2.3MiB")).toThrow("invalid size");
    expect(() => legacyParseFileSizeLimit("1 2MiB")).toThrow("invalid size");
    expect(() => legacyParseFileSizeLimit("-5MiB")).toThrow("invalid size");
  });

  it("rejects an overflowing numeral (Go ParseFloat range error)", () => {
    expect(() => legacyParseFileSizeLimit("1e309")).toThrow("invalid size");
  });
});

describe("legacyBucketHasKey", () => {
  const doc = { storage: { buckets: { docs: { public: true } } } };

  it("detects a declared key", () => {
    expect(legacyBucketHasKey(doc, "docs", "public")).toBe(true);
  });

  it("returns false for an omitted key", () => {
    expect(legacyBucketHasKey(doc, "docs", "file_size_limit")).toBe(false);
  });

  it("returns false when the document, storage, buckets, or bucket is absent", () => {
    expect(legacyBucketHasKey(undefined, "docs", "public")).toBe(false);
    expect(legacyBucketHasKey({}, "docs", "public")).toBe(false);
    expect(legacyBucketHasKey({ storage: {} }, "docs", "public")).toBe(false);
    expect(legacyBucketHasKey({ storage: { buckets: {} } }, "docs", "public")).toBe(false);
  });
});

describe("legacyResolveBucketProps", () => {
  const entry = { public: true, file_size_limit: "10MiB", allowed_mime_types: ["image/png"] };

  it("uses the explicit public + parsed file_size_limit when declared", () => {
    const doc = {
      storage: { buckets: { media: { public: true, file_size_limit: "10MiB" } } },
    };
    expect(
      legacyResolveBucketProps({
        document: doc,
        name: "media",
        bucket: entry,
        storageFileSizeLimitBytes: 5 * 1024 * 1024,
      }),
    ).toEqual({
      public: true,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/png"],
    });
  });

  it("inherits the storage-level limit and omits public when both are absent", () => {
    expect(
      legacyResolveBucketProps({
        document: { storage: { buckets: { media: {} } } },
        name: "media",
        bucket: { public: false, file_size_limit: "50MiB", allowed_mime_types: [] },
        storageFileSizeLimitBytes: 5 * 1024 * 1024,
      }),
    ).toEqual({ public: undefined, fileSizeLimit: 5 * 1024 * 1024, allowedMimeTypes: [] });
  });

  it("throws on an unparseable bucket file_size_limit", () => {
    expect(() =>
      legacyResolveBucketProps({
        document: { storage: { buckets: { media: { file_size_limit: "bad" } } } },
        name: "media",
        bucket: { public: false, file_size_limit: "bad", allowed_mime_types: [] },
        storageFileSizeLimitBytes: 0,
      }),
    ).toThrow("invalid size");
  });
});
