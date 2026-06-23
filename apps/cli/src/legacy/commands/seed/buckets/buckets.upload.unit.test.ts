import { describe, expect, it } from "@effect/vitest";

import {
  legacyBucketObjectKey,
  legacyContentTypeForUpload,
  legacyParseFileSizeLimit,
} from "./buckets.upload.ts";

/** Latin-1 byte view of a string fixture. */
function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

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

describe("legacyContentTypeForUpload", () => {
  // Go: http.DetectContentType (bytes win) then refine only generic text/plain
  // by extension via mime.TypeByExtension (objects.go:77-108).
  it("lets the sniffed bytes win over the extension (PNG named .txt)", () => {
    const png = bytes("\x89PNG\x0D\x0A\x1A\x0A\x00\x00");
    expect(legacyContentTypeForUpload(png, "/x/a.txt")).toBe("image/png");
  });

  it("refines a generic text/plain sniff via the file extension", () => {
    const text = bytes('{"a":1}'); // sniffs as text/plain
    expect(legacyContentTypeForUpload(text, "/x/a.json")).toBe("application/json");
    expect(legacyContentTypeForUpload(text, "/x/a.css")).toBe("text/css; charset=utf-8");
  });

  it("is case-insensitive on the extension for the text refinement", () => {
    expect(legacyContentTypeForUpload(bytes("plain text"), "/x/A.JSON")).toBe("application/json");
  });

  it("keeps text/plain when a text file has no/unknown extension", () => {
    // mime.TypeByExtension returns "" → Go keeps the sniffed text/plain.
    expect(legacyContentTypeForUpload(bytes("plain text"), "/x/a.unknownext")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(legacyContentTypeForUpload(bytes("plain text"), "/x/noext")).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("does not refine a non-text sniff result by extension", () => {
    // An SVG body sniffs as text/xml (not text/plain), so the .svg extension
    // refinement is NOT applied — matches Go (refine gate is text/plain only).
    const svg = bytes('<?xml version="1.0"?><svg></svg>');
    expect(legacyContentTypeForUpload(svg, "/x/a.svg")).toBe("text/xml; charset=utf-8");
  });

  it("falls back to application/octet-stream for unrecognized binary content", () => {
    const blob = bytes("\x00\x01\x02\x03\x04\x05garbage");
    expect(legacyContentTypeForUpload(blob, "/x/a.bin")).toBe("application/octet-stream");
  });
});
