import { describe, expect, it } from "vitest";

import {
  legacyContentTypeForUpload,
  legacyRefineUploadContentType,
} from "./legacy-storage-content-type.ts";

/** Latin-1 byte view of a string fixture. */
function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

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
    expect(legacyContentTypeForUpload(bytes("plain text"), "/x/a.unknownext")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(legacyContentTypeForUpload(bytes("plain text"), "/x/noext")).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("does not refine a non-text sniff result by extension", () => {
    const svg = bytes('<?xml version="1.0"?><svg></svg>');
    expect(legacyContentTypeForUpload(svg, "/x/a.svg")).toBe("text/xml; charset=utf-8");
  });

  it("falls back to application/octet-stream for unrecognized binary content", () => {
    const blob = bytes("\x00\x01\x02\x03\x04\x05garbage");
    expect(legacyContentTypeForUpload(blob, "/x/a.bin")).toBe("application/octet-stream");
  });
});

describe("legacyRefineUploadContentType", () => {
  it("refines an explicit text/plain content-type by extension (Go refines the flag too)", () => {
    expect(legacyRefineUploadContentType("text/plain", "/x/a.json")).toBe("application/json");
  });

  it("leaves a non-text content-type untouched", () => {
    expect(legacyRefineUploadContentType("image/png", "/x/a.json")).toBe("image/png");
  });
});
