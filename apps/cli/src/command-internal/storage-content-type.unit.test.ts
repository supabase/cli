import { describe, expect, it } from "vitest";

import { contentTypeForUpload, refineUploadContentType } from "./storage-content-type.ts";

/** Latin-1 byte view of a string fixture. */
function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

describe("contentTypeForUpload", () => {
  // `http.DetectContentType` (bytes win) then refine only generic text/plain
  // by extension via `mime.TypeByExtension`.
  it("lets the sniffed bytes win over the extension (PNG named .txt)", () => {
    const png = bytes("\x89PNG\x0D\x0A\x1A\x0A\x00\x00");
    expect(contentTypeForUpload(png, "/x/a.txt")).toBe("image/png");
  });

  it("refines a generic text/plain sniff via the file extension", () => {
    const text = bytes('{"a":1}'); // sniffs as text/plain
    expect(contentTypeForUpload(text, "/x/a.json")).toBe("application/json");
    expect(contentTypeForUpload(text, "/x/a.css")).toBe("text/css; charset=utf-8");
  });

  it("is case-insensitive on the extension for the text refinement", () => {
    expect(contentTypeForUpload(bytes("plain text"), "/x/A.JSON")).toBe("application/json");
  });

  it("keeps text/plain when a text file has no/unknown extension", () => {
    expect(contentTypeForUpload(bytes("plain text"), "/x/a.unknownext")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(contentTypeForUpload(bytes("plain text"), "/x/noext")).toBe("text/plain; charset=utf-8");
  });

  it("does not refine a non-text sniff result by extension", () => {
    const svg = bytes('<?xml version="1.0"?><svg></svg>');
    expect(contentTypeForUpload(svg, "/x/a.svg")).toBe("text/xml; charset=utf-8");
  });

  it("falls back to application/octet-stream for unrecognized binary content", () => {
    const blob = bytes("\x00\x01\x02\x03\x04\x05garbage");
    expect(contentTypeForUpload(blob, "/x/a.bin")).toBe("application/octet-stream");
  });
});

describe("refineUploadContentType", () => {
  it("refines an explicit text/plain content-type by extension (Go refines the flag too)", () => {
    expect(refineUploadContentType("text/plain", "/x/a.json")).toBe("application/json");
  });

  it("leaves a non-text content-type untouched", () => {
    expect(refineUploadContentType("image/png", "/x/a.json")).toBe("image/png");
  });
});
