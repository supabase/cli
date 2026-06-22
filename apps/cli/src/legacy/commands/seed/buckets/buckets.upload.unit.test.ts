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
