import { describe, expect, it } from "vitest";

import { legacyDetectContentType } from "./legacy-detect-content-type.ts";

/** Latin-1 byte view of a string (matches Go's []byte("…") for our fixtures). */
function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

describe("legacyDetectContentType", () => {
  // Expected values produced by running Go's `http.DetectContentType` (go1.x)
  // over the identical byte inputs — this locks the port to byte-exact parity.
  const corpus: ReadonlyArray<readonly [string, string, string]> = [
    ["png", "\x89PNG\x0D\x0A\x1A\x0A\x00\x00", "image/png"],
    ["pdf", "%PDF-1.4\n...", "application/pdf"],
    ["gif89", "GIF89a....", "image/gif"],
    ["jpeg", "\xFF\xD8\xFF\xE0\x00\x10JFIF", "image/jpeg"],
    ["html_doctype", "<!DOCTYPE HTML><html></html>", "text/html; charset=utf-8"],
    ["html_lc", "<html><body>hi</body></html>", "text/html; charset=utf-8"],
    ["html_ws", "   \n<HTML>", "text/html; charset=utf-8"],
    ["xml", '<?xml version="1.0"?><svg/>', "text/xml; charset=utf-8"],
    ["plain", "hello world\n", "text/plain; charset=utf-8"],
    ["empty", "", "text/plain; charset=utf-8"],
    ["gzip", "\x1F\x8B\x08\x00\x00", "application/x-gzip"],
    ["zip", "PK\x03\x04\x14", "application/zip"],
    ["wasm", "\x00asm\x01\x00\x00\x00", "application/wasm"],
    ["bmp", "BM\x00\x00", "image/bmp"],
    ["utf8bom", "\xEF\xBB\xBFhello", "text/plain; charset=utf-8"],
    ["utf16be", "\xFE\xFF\x00h", "text/plain; charset=utf-16be"],
    ["ogg", "OggS\x00\x02", "application/ogg"],
    ["binary_ctrl", "\x00\x01\x02\x03\x04\x05garbage", "application/octet-stream"],
    ["webp", "RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"],
    ["ttf", "\x00\x01\x00\x00\x00", "font/ttf"],
    ["json_like", '{"a":1}', "text/plain; charset=utf-8"],
  ];

  for (const [name, input, expected] of corpus) {
    it(`matches Go http.DetectContentType for ${name}`, () => {
      expect(legacyDetectContentType(bytes(input))).toBe(expected);
    });
  }

  it("considers only the first 512 bytes (a PNG magic past 512 is ignored)", () => {
    // 600 bytes of plain text then a PNG magic — beyond the sniff window, so it
    // stays text/plain (Go truncates to data[:512]).
    const padded = "a".repeat(600) + "\x89PNG\x0D\x0A\x1A\x0A";
    expect(legacyDetectContentType(bytes(padded))).toBe("text/plain; charset=utf-8");
  });
});
