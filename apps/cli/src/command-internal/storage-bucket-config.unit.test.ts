import { describe, expect, it } from "vitest";

import { bucketHasKey, parseFileSizeLimit, resolveBucketProps } from "./storage-bucket-config.ts";

describe("parseFileSizeLimit", () => {
  it("parses a human-readable size to bytes", () => {
    expect(parseFileSizeLimit("50MiB")).toBe(50 * 1024 * 1024);
  });

  it("returns 0 for a zero limit", () => {
    expect(parseFileSizeLimit("0")).toBe(0);
  });

  it("throws on an unparseable value", () => {
    expect(() => parseFileSizeLimit("not-a-size")).toThrow();
  });

  it("accepts Go-valid numeral forms (strconv.ParseFloat parity)", () => {
    expect(parseFileSizeLimit(".5MiB")).toBe(Math.trunc(0.5 * 1024 * 1024));
    expect(parseFileSizeLimit("1.MiB")).toBe(1024 * 1024);
    expect(parseFileSizeLimit("1e6")).toBe(1_000_000);
    expect(parseFileSizeLimit("1_000MiB")).toBe(1000 * 1024 * 1024);
    expect(parseFileSizeLimit("1_0MiB")).toBe(10 * 1024 * 1024);
  });

  it("rejects badly-placed underscores (Go literal rule)", () => {
    expect(() => parseFileSizeLimit("_1000MiB")).toThrow("invalid size");
    expect(() => parseFileSizeLimit("1__0MiB")).toThrow("invalid size");
  });

  it("rejects malformed numerals that JS parseFloat would truncate", () => {
    expect(() => parseFileSizeLimit("1.2.3MiB")).toThrow("invalid size");
    expect(() => parseFileSizeLimit("1 2MiB")).toThrow("invalid size");
    expect(() => parseFileSizeLimit("-5MiB")).toThrow("invalid size");
  });

  it("rejects an overflowing numeral (Go ParseFloat range error)", () => {
    expect(() => parseFileSizeLimit("1e309")).toThrow("invalid size");
  });
});

describe("bucketHasKey", () => {
  const doc = { storage: { buckets: { docs: { public: true } } } };

  it("detects a declared key", () => {
    expect(bucketHasKey(doc, "docs", "public")).toBe(true);
  });

  it("returns false for an omitted key", () => {
    expect(bucketHasKey(doc, "docs", "file_size_limit")).toBe(false);
  });

  it("returns false when the document, storage, buckets, or bucket is absent", () => {
    expect(bucketHasKey(undefined, "docs", "public")).toBe(false);
    expect(bucketHasKey({}, "docs", "public")).toBe(false);
    expect(bucketHasKey({ storage: {} }, "docs", "public")).toBe(false);
    expect(bucketHasKey({ storage: { buckets: {} } }, "docs", "public")).toBe(false);
  });
});

describe("resolveBucketProps", () => {
  const entry = { public: true, file_size_limit: "10MiB", allowed_mime_types: ["image/png"] };

  it("uses the explicit public + parsed file_size_limit when declared", () => {
    const doc = {
      storage: { buckets: { media: { public: true, file_size_limit: "10MiB" } } },
    };
    expect(
      resolveBucketProps({
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
      resolveBucketProps({
        document: { storage: { buckets: { media: {} } } },
        name: "media",
        bucket: { public: false, file_size_limit: "50MiB", allowed_mime_types: [] },
        storageFileSizeLimitBytes: 5 * 1024 * 1024,
      }),
    ).toEqual({ public: undefined, fileSizeLimit: 5 * 1024 * 1024, allowedMimeTypes: [] });
  });

  it("throws on an unparseable bucket file_size_limit", () => {
    expect(() =>
      resolveBucketProps({
        document: { storage: { buckets: { media: { file_size_limit: "bad" } } } },
        name: "media",
        bucket: { public: false, file_size_limit: "bad", allowed_mime_types: [] },
        storageFileSizeLimitBytes: 0,
      }),
    ).toThrow("invalid size");
  });
});
